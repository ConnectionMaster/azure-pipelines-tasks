import * as path from 'path';
import * as tl from 'azure-pipelines-task-lib/task';
import * as URL from 'url';
import * as fs from 'fs';
import * as constants from './constants';
import * as npmregistry from 'azure-pipelines-tasks-packaging-common/npm/npmregistry';
import * as util from 'azure-pipelines-tasks-packaging-common/util';
import * as npmutil from 'azure-pipelines-tasks-packaging-common/npm/npmutil';
import * as os from 'os';
import * as npmrcparser from 'azure-pipelines-tasks-packaging-common/npm/npmrcparser';
import * as pkgLocationUtils from 'azure-pipelines-tasks-packaging-common/locationUtilities';
import { emitTelemetry } from "azure-pipelines-tasks-artifacts-common/telemetry";
#if WIF
import { getFederatedWorkloadIdentityCredentials, getFeedTenantId } from "azure-pipelines-tasks-artifacts-common/EntraWifUserServiceConnectionUtils";
#endif

let internalFeedSuccessCount: number = 0;
let externalFeedSuccessCount: number = 0;
let federatedFeedAuthSuccessCount: number = 0;

async function main(): Promise<void> {
    tl.setResourcePath(path.join(__dirname, 'task.json'));
    let saveNpmrcPath: string;
    let npmrc = tl.getInput(constants.NpmAuthenticateTaskInput.WorkingFile);
    let workingDirectory = path.dirname(npmrc);
    let endpointsArray = tl.getVariable('EXISTING_ENDPOINTS') 
        ? tl.getVariable('EXISTING_ENDPOINTS').split(',') 
        : [];

    if (!(npmrc.endsWith('.npmrc'))) {
        throw new Error(tl.loc('NpmrcNotNpmrc', npmrc));
    }
    else if (!tl.exist(npmrc)) {
        throw new Error(tl.loc('NpmrcDoesNotExist', npmrc));
    }
    else {
        console.log(tl.loc("AuthenticatingThisNpmrc", npmrc));
    }

    if (tl.getVariable("SAVE_NPMRC_PATH")) {
        saveNpmrcPath = tl.getVariable("SAVE_NPMRC_PATH");
    }
    else {
        let tempPath = tl.getVariable('Agent.BuildDirectory') || tl.getVariable('Agent.TempDirectory');
        tempPath = path.join(tempPath, 'npmAuthenticate');
        tl.mkdirP(tempPath);
        saveNpmrcPath = fs.mkdtempSync(tempPath + path.sep);
        tl.setVariable("SAVE_NPMRC_PATH", saveNpmrcPath, false);
        tl.setVariable("NPM_AUTHENTICATE_TEMP_DIRECTORY", tempPath, false);
    }
    let npmrcTable: Object;

    //The index file is a json object that keeps track of where .npmrc files are saved.
    //There is a key-value pairing of filepaths of original npmrc files to IDs.
    //This is important so multiple runs of the npm Authenticate task on the same .npmrc file actually reverts to the original after the build completes.
    let indexFile = path.join(saveNpmrcPath, 'index.json');

    if (fs.existsSync(indexFile)) { //If the file exists, add to it.
        npmrcTable = JSON.parse(fs.readFileSync(indexFile, 'utf8'));

    }
    else { //If the file doesn't exist, create it. 
        npmrcTable = new Object();
        npmrcTable['index'] = 0;
    }

    if (npmrcTable[npmrc] === undefined) {
        npmrcTable[npmrc] = npmrcTable['index'];
        npmrcTable['index']++;
        fs.writeFileSync(indexFile, JSON.stringify(npmrcTable));
        util.saveFileWithName(npmrc, npmrcTable[npmrc], saveNpmrcPath);
    }
    
    let packagingLocation: pkgLocationUtils.PackagingLocation;
    try {
        packagingLocation = await pkgLocationUtils.getPackagingUris(pkgLocationUtils.ProtocolType.Npm);
    } catch (error) {
        tl.debug('Unable to get packaging URIs');
        util.logError(error);
        throw error;
    }
    // Getting local registries will also save normalized registries in the npmrc
    let LocalNpmRegistries = await npmutil.getLocalNpmRegistries(workingDirectory, packagingLocation.PackagingUris);
    let npmrcFile = fs.readFileSync(npmrc, 'utf8').split(os.EOL);

    let endpointRegistries: npmregistry.INpmRegistry[] = [];
    let endpointIds = tl.getDelimitedInput(constants.NpmAuthenticateTaskInput.CustomEndpoint, ',');
    if (endpointIds && endpointIds.length > 0) {
        await Promise.all(endpointIds.map(async e => {
            var registry = await npmregistry.NpmRegistry.FromServiceEndpoint(e, true);

            // Add newly discovered endpoints to env variable. Warn of duplicates.
            if (endpointsArray.includes(registry.url)){
                tl.warning(tl.loc('DuplicateCredentials', registry.url));
            }
            else {
                endpointsArray.push(registry.url);
                tl.setVariable('EXISTING_ENDPOINTS', endpointsArray.join(','), false);
            }
            endpointRegistries.push(registry);
        }));
    }

    let addedRegistry = [];
    let npmrcRegistries = npmrcparser.GetRegistries(npmrc, /* saveNormalizedRegistries */ true);

#if WIF
    const entraWifServiceConnectionName = tl.getInput("workloadIdentityServiceConnection");
    const federatedAuthToken = await getAzureDevOpsServiceConnectionCredentials(entraWifServiceConnectionName)

    const feedUrl = tl.getInput("feedUrl");
    if (feedUrl && !entraWifServiceConnectionName) {
        throw new Error(tl.loc("MissingFeedUrlOrServiceConnection"));
    }

    if(feedUrl){
        npmrcRegistries = npmrcRegistries.filter(x=> util.toNerfDart(x) == util.toNerfDart(npmrcparser.NormalizeRegistry(feedUrl)));
        if(npmrcRegistries.length == 0){
            throw new Error(tl.loc("IgnoringRegistry", feedUrl));
        }
    }
#endif

    for (let RegistryURLString of npmrcRegistries) {
        let registryURL = URL.parse(RegistryURLString);
        let registry: npmregistry.NpmRegistry;

#if WIF
        if (feedUrl && entraWifServiceConnectionName){
            if (util.toNerfDart(npmrcparser.NormalizeRegistry(feedUrl)) == util.toNerfDart(RegistryURLString)) {
                console.log(tl.loc("AddingEndpointCredentials", entraWifServiceConnectionName));
                registry =  new npmregistry.NpmRegistry(RegistryURLString, `${util.toNerfDart(RegistryURLString)}:_authToken=${federatedAuthToken}`, true);
                let url = URL.parse(RegistryURLString);
                addedRegistry.push(url);
                npmrcFile = clearFileOfReferences(npmrc, npmrcFile, url, addedRegistry);
                federatedFeedAuthSuccessCount++;
                console.log(tl.loc("Info_SuccessAddingFederatedFeedAuth", RegistryURLString));
            }
        } else if (!feedUrl && entraWifServiceConnectionName){
            console.log(tl.loc("AddingEndpointCredentials", entraWifServiceConnectionName));
            registry = new npmregistry.NpmRegistry(RegistryURLString, `${util.toNerfDart(RegistryURLString)}:_authToken=${federatedAuthToken}`, true)
            let url = URL.parse(RegistryURLString);
            addedRegistry.push(url);
            npmrcFile = clearFileOfReferences(npmrc, npmrcFile, url, addedRegistry);
            federatedFeedAuthSuccessCount++;
            console.log(tl.loc("Info_SuccessAddingFederatedFeedAuth", RegistryURLString));
        }
#endif

        if (!registry && endpointRegistries && endpointRegistries.length > 0) {
            for (let serviceEndpoint of endpointRegistries) {
                if (util.toNerfDart(serviceEndpoint.url) == util.toNerfDart(RegistryURLString)) {
                    let serviceURL = URL.parse(serviceEndpoint.url);
                    console.log(tl.loc("AddingEndpointCredentials", registryURL.host));
                    registry = serviceEndpoint;
                    addedRegistry.push(serviceURL);
                    npmrcFile = clearFileOfReferences(npmrc, npmrcFile, serviceURL, addedRegistry);
                    externalFeedSuccessCount++;
                    break;
                }
            }
        }

        if (!registry) {
            for (let localRegistry of LocalNpmRegistries) {
                if (util.toNerfDart(localRegistry.url) == util.toNerfDart(RegistryURLString)) {
                    // If a registry is found, but we previously added credentials for it warn and overwrite
                    if (endpointsArray.includes(localRegistry.url)) {
                        tl.warning(tl.loc('DuplicateCredentials', localRegistry.url));
                        tl.warning(tl.loc('FoundEndpointCredentials', registryURL.host));
                    }
                    let localURL = URL.parse(localRegistry.url);
                    console.log(tl.loc("AddingLocalCredentials"));
                    registry = localRegistry;
                    addedRegistry.push(localURL);
                    npmrcFile = clearFileOfReferences(npmrc, npmrcFile, localURL, addedRegistry);                    
                    break;
                }
            }
        }

        if (registry) {
            tl.debug(tl.loc('AddingAuthRegistry', registry.url));
            npmutil.appendToNpmrc(npmrc, os.EOL + registry.auth + os.EOL);
            tl.debug(tl.loc('SuccessfulAppend'));
            npmrcFile.push(os.EOL + registry.auth + os.EOL);
            tl.debug(tl.loc('SuccessfulPush'));
        }
        else {
            console.log(tl.loc("IgnoringRegistry", registryURL.host));
        }
    }
}

main().catch(error => {
    if (tl.getVariable("NPM_AUTHENTICATE_TEMP_DIRECTORY")) {
        tl.rmRF(tl.getVariable("NPM_AUTHENTICATE_TEMP_DIRECTORY"));
        // Clear the variables after we rm-rf the main root directory
        tl.setVariable("SAVE_NPMRC_PATH", "", false);
        tl.setVariable("NPM_AUTHENTICATE_TEMP_DIRECTORY", "", false);
    } 
    tl.setResult(tl.TaskResult.Failed, error);
}).finally(() => {
    emitTelemetry("Packaging", "NpmAuthenticateV0", {
        "InternalFeedAuthCount": internalFeedSuccessCount,
        "ExternalFeedAuthCount": externalFeedSuccessCount,
        "FederatedFeedAuthCount": federatedFeedAuthSuccessCount
    });
});

function clearFileOfReferences(npmrc: string, file: string[], url: URL.Url, addedRegistry: URL.Url[]) {
    let redoneFile = file;
    let warned = false;
    for (let i = 0; i < redoneFile.length; i++) {
        if (file[i].indexOf(url.host) != -1 && file[i].indexOf(url.path) != -1 && file[i].indexOf('registry=') == -1) {
            // Suppress the warning if it is the same registry from .npmrc
            // E.g. registry={url} and @scope:registry={url} in .npmrc, the warning should not appear if both have the same url
            if (!warned && !addedRegistry.includes(url)) {
                tl.warning(tl.loc('CheckedInCredentialsOverriden', url.host));
            }
            warned = true;
            redoneFile[i] = '';
        }
    }
    fs.writeFileSync(npmrc, redoneFile.join(os.EOL));
    return redoneFile;
}

#if WIF
async function getAzureDevOpsServiceConnectionCredentials(adoServiceConnection: string){
    if(!adoServiceConnection){
        return undefined;
    }

    let federatedAuthToken = await getFederatedWorkloadIdentityCredentials(adoServiceConnection);
    if(!federatedAuthToken){
        throw new Error(tl.loc("FailedToGetServiceConnectionAuth", adoServiceConnection)); 
    }

    return federatedAuthToken;
}
#endif
