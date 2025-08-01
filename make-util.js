const ncp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const process = require('process');

const { XMLParser } = require('fast-xml-parser');
const minimatch = require('minimatch');
const minimist = require('minimist');
const Downloader = require('nodejs-file-downloader');
const check = require('validator').default;
const semver = require('semver');
const shell = require('shelljs');

const makeOptions = require('./make-options.json');

const args = minimist(process.argv.slice(2));

// global paths
var repoPath = __dirname;
var downloadPath = path.join(repoPath, '_download');

// list of .NET culture names
var cultureNames = ['cs', 'de', 'es', 'fr', 'it', 'ja', 'ko', 'pl', 'pt-BR', 'ru', 'tr', 'zh-Hans', 'zh-Hant'];

var allowedTypescriptVersions = ['4.0.2', '4.9.5', '5.1.6'];

//------------------------------------------------------------------------------
// shell functions
//------------------------------------------------------------------------------
var shellAssert = function () {
    var errMsg = shell.error();
    if (errMsg) {
        throw new Error(errMsg.toString());
    }
}

var cd = function (dir) {
    var cwd = process.cwd();
    if (cwd != dir) {
        console.log('');
        console.log(`> cd ${path.relative(cwd, dir)}`);
        shell.cd(dir);
        shellAssert();
    }
}
exports.cd = cd;

var cp = function (options, source, dest) {
    if (dest) {
        shell.cp(options, source, dest);
    }
    else {
        shell.cp(options, source);
    }

    shellAssert();
}
exports.cp = cp;

var mkdir = function (options, target) {
    if (target) {
        shell.mkdir(options, target);
    }
    else {
        shell.mkdir(options);
    }

    shellAssert();
}
exports.mkdir = mkdir;

var rm = function (options, target) {
    if (target) {
        shell.rm(options, target);
    }
    else {
        shell.rm(options);
    }

    shellAssert();
}
exports.rm = rm;

var test = function (options, p) {
    var result = shell.test(options, p);
    shellAssert();
    return result;
}
exports.test = test;
//------------------------------------------------------------------------------

var assert = function (value, name) {
    if (!value) {
        throw new Error('"' + name + '" cannot be null or empty.');
    }
}
exports.assert = assert;

var banner = function (message, noBracket) {
    console.log();
    if (!noBracket) {
        console.log('------------------------------------------------------------');
    }
    console.log(message);
    if (!noBracket) {
        console.log('------------------------------------------------------------');
    }
}
exports.banner = banner;

var rp = function (relPath) {
    return path.join(shell.pwd() + '', relPath);
}
exports.rp = rp;

var fail = function (message) {
    console.error('ERROR: ' + message);
    process.exit(1);
}
exports.fail = fail;

var ensureExists = function (checkPath) {
    assert(checkPath, 'checkPath');
    var exists = test('-d', checkPath) || test('-f', checkPath);

    if (!exists) {
        fail(checkPath + ' does not exist');
    }
}
exports.ensureExists = ensureExists;

var pathExists = function (checkPath) {
    return test('-d', checkPath) || test('-f', checkPath);
}
exports.pathExists = pathExists;

/**
 * Given a module path, gets the info used for generating a pack file
 */
var getCommonPackInfo = function (modOutDir) {
    // assert the module has a package.json
    var packageJsonPath = path.join(modOutDir, 'package.json');
    if (!test('-f', packageJsonPath)) {
        fail(`Common module package.json does not exist: '${packageJsonPath}'`);
    }

    // assert the package name and version
    var packageJson = JSON.parse(fs.readFileSync(packageJsonPath));
    if (!packageJson || !packageJson.name || !packageJson.version) {
        fail(`The common module's package.json must define a name and version: ${packageJsonPath}`);
    }

    var packFileName = `${packageJson.name}-${packageJson.version}.tgz`;
    return {
        "packageName": packageJson.name,
        "packFilePath": path.join(path.dirname(modOutDir), packFileName)
    };
}
exports.getCommonPackInfo = getCommonPackInfo;

function performNpmAudit(taskPath) {
    console.log('\n🛫 Running npm audit...');

    if (process.env['TF_BUILD']) {
        console.log(`\x1b[A\x1b[K⏭️  Skipping npm audit in build pipeline because it is not supported in the pipeline.`);
        return;
    }

    if (args.BypassNpmAudit) {
        console.log(`\x1b[A\x1b[K⏭️  Skipping npm audit because --BypassNpmAudit argument is set.`);
        return;
    }

    try {
        const auditResult = ncp.spawnSync('npm', ['audit', '--prefix', taskPath, '--audit-level=high'], {
            stdio: 'pipe',
            encoding: 'utf8',
            shell: true
        });

        if (auditResult.error) {
            console.log(`\x1b[A\x1b[K❌ npm audit failed because the build task at "${taskPath}" has vulnerable dependencies.`);
            console.log('👉 Please see details by running the command');
            console.log(`\tnpm audit --prefix ${taskPath}`);
            console.log('or execute the command with --BypassNpmAudit argument to skip the auditing');
            console.log(`\tnode make.js --build --task ${args.task} --BypassNpmAudit`);
            process.exit(1);
        } else {
            console.log('\x1b[A\x1b[K✅ npm audit completed successfully.');
        }
    } catch (error) {
        console.error('\x1b[A\x1b[K❌ "performNpmAudit" failed.');
        console.error(error.message);
        process.exit(1);
    }
}

var buildNodeTask = function (taskPath, outDir, isServerBuild) {
    var originalDir = shell.pwd().toString();
    cd(taskPath);
    var packageJsonPath = rp('package.json');
    var overrideTscPath;
    if (test('-f', packageJsonPath)) {
        // verify no dev dependencies
        // we allow only two dev dependencies: typescript and @tsconfig/node10
        var packageJson = JSON.parse(fs.readFileSync(packageJsonPath).toString());
        var devDeps = packageJson.devDependencies ? Object.keys(packageJson.devDependencies).length : 0;
        if (devDeps === 1 && packageJson.devDependencies['typescript'] || (devDeps === 2 && packageJson.devDependencies['typescript'] && packageJson.devDependencies['@tsconfig/node10'])) {
            var version = packageJson.devDependencies['typescript'];
            if (!allowedTypescriptVersions.includes(version)) {
                fail(`The package.json specifies a different TS version (${version}) that the allowed versions: ${allowedTypescriptVersions}. Offending package.json: ${packageJsonPath}`);
            }
            overrideTscPath = path.join(taskPath, "node_modules", "typescript");
            console.log(`Detected Typescript version: ${version}`);
        } else if (devDeps >= 1) {
            fail('The package.json should not contain dev dependencies other than typescript. Move the dev dependencies into a package.json file under the Tests sub-folder. Offending package.json: ' + packageJsonPath);
        }
        if (isServerBuild) {
            run('npm ci');
        } else {
            run('npm install');
        }
    }

    if (test('-f', rp(path.join('Tests', 'package.json')))) {
        cd(rp('Tests'));
        if (isServerBuild) {
            run('npm ci');
        } else {
            run('npm install');
        }
        cd(taskPath);
    }

    performNpmAudit(taskPath);

    // Use the tsc version supplied by the task if it is available, otherwise use the global default.
    if (overrideTscPath) {
        var tscExec = path.join(overrideTscPath, "bin", "tsc");
        run("node " + tscExec + ' --outDir "' + outDir + '" --rootDir "' + taskPath + '"');
        // Don't include typescript in node_modules
        rm("-rf", overrideTscPath);
    } else {
        run('tsc --outDir "' + outDir + '" --rootDir "' + taskPath + '"');
    }

    cd(originalDir);
}
exports.buildNodeTask = buildNodeTask;

var copyTaskResources = function (taskMake, srcPath, destPath) {
    assert(taskMake, 'taskMake');
    assert(srcPath, 'srcPath');
    assert(destPath, 'destPath');

    // copy the globally defined set of default task resources
    var toCopy = makeOptions['taskResources'];
    toCopy.forEach(function (item) {
        matchCopy(item, srcPath, destPath, { noRecurse: true, matchBase: true });
    });

    // copy the locally defined set of resources
    if (taskMake.hasOwnProperty('cp')) {
        copyGroups(taskMake.cp, srcPath, destPath);
    }

    // remove the locally defined set of resources
    if (taskMake.hasOwnProperty('rm')) {
        removeGroups(taskMake.rm, destPath);
    }
}
exports.copyTaskResources = copyTaskResources;

var matchFind = function (pattern, root, options) {
    assert(pattern, 'pattern');
    assert(root, 'root');

    // create a copy of the options
    var clone = {};
    Object.keys(options || {}).forEach(function (key) {
        clone[key] = options[key];
    });
    options = clone;

    // determine whether to recurse
    var noRecurse = options.hasOwnProperty('noRecurse') && options.noRecurse;
    delete options.noRecurse;

    // normalize first, so we can substring later
    root = path.resolve(root);

    // determine the list of items
    var items;
    if (noRecurse) {
        items = fs.readdirSync(root)
            .map(function (name) {
                return path.join(root, name);
            });
    }
    else {
        items = shell.find(root)
            .filter(function (item) { // filter out the root folder
                return path.normalize(item) != root;
            });
    }

    return minimatch.match(items, pattern, options);
}
exports.matchFind = matchFind;

var matchCopy = function (pattern, sourceRoot, destRoot, options) {
    assert(pattern, 'pattern');
    assert(sourceRoot, 'sourceRoot');
    assert(destRoot, 'destRoot');

    console.log(`copying ${pattern}`);

    // normalize first, so we can substring later
    sourceRoot = path.resolve(sourceRoot);
    destRoot = path.resolve(destRoot);

    matchFind(pattern, sourceRoot, options)
        .forEach(function (item) {
            // create the dest dir based on the relative item path
            var relative = item.substring(sourceRoot.length + 1);
            assert(relative, 'relative'); // should always be filterd out by matchFind
            var dest = path.dirname(path.join(destRoot, relative));
            mkdir('-p', dest);

            cp('-Rf', item, dest + '/');
        });
}
exports.matchCopy = matchCopy;

var run = function (cl, inheritStreams, noHeader, throwOnError) {
    if (!noHeader) {
        console.log();
        console.log('> ' + cl);
    }

    var options = {
        stdio: inheritStreams ? 'inherit' : 'pipe'
    };
    var rc = 0;
    var output;
    try {
        output = ncp.execSync(cl, options);
    }
    catch (err) {
        if (!inheritStreams) {
            console.error(err.output ? err.output.toString() : err.message);
        }

        if(throwOnError)
        {
            throw new Error('Failed to run: ' + cl + ' exit code: ' + err.status);
        }else{
            process.exit(1);
        }
    }

    return (output || '').toString().trim();
}
exports.run = run;


var ensureTool = function (name, versionArgs, validate) {
    console.log(name + ' tool:');
    var toolPath = shell.which(name);
    if (!toolPath) {
        fail(name + ' not found.  might need to run npm install');
    }

    if (versionArgs) {
        var result = shell.exec(name + ' ' + versionArgs);
        if (typeof validate == 'string') {
            if (result.stdout.trim() != validate) {
                fail('expected version: ' + validate);
            }
        }
        else {
            validate(result.stdout.trim());
        }
    }

    console.log(toolPath + '');
}
exports.ensureTool = ensureTool;

const node20Version = '20.17.0';
exports.node20Version = node20Version;

var installNodeAsync = async function (nodeVersion) {
    const versions = {
        20: node20Version
    };

    if (!nodeVersion) {
        nodeVersion = 'v' + versions[20];
    } else {
        if (!versions[nodeVersion]) {
            fail(`Unexpected node version '${nodeVersion}'. Supported versions: ${Object.keys(versions).join(', ')}`);
        };
        nodeVersion = 'v' + versions[nodeVersion];
    }

    if (nodeVersion === run('node -v')) {
        console.log('skipping node install for tests since correct version is running');
        return;
    }

    // determine the platform
    var platform = os.platform();
    if (platform != 'darwin' && platform != 'linux' && platform != 'win32') {
        throw new Error('Unexpected platform: ' + platform);
    }

    var nodeUrl = 'https://nodejs.org/dist';
    switch (platform) {
        case 'darwin':
            var nodeArchivePath = await downloadArchiveAsync(nodeUrl + '/' + nodeVersion + '/node-' + nodeVersion + '-darwin-x64.tar.gz');
            addPath(path.join(nodeArchivePath, 'node-' + nodeVersion + '-darwin-x64', 'bin'));
            break;
        case 'linux':
            var nodeArchivePath = await downloadArchiveAsync(nodeUrl + '/' + nodeVersion + '/node-' + nodeVersion + '-linux-x64.tar.gz');
            addPath(path.join(nodeArchivePath, 'node-' + nodeVersion + '-linux-x64', 'bin'));
            break;
        case 'win32':
            var nodeArchivePath = await downloadArchiveAsync(nodeUrl + '/' + nodeVersion + '/node-' + nodeVersion + '-win-x64.zip');
            addPath(path.join(nodeArchivePath, 'node-' + nodeVersion + '-win-x64'));
            break;
    }
}
exports.installNodeAsync = installNodeAsync;

var downloadFileAsync = async function (url) {
    // validate parameters
    if (!url) {
        throw new Error('Parameter "url" must be set.');
    }

    // skip if already downloaded
    const scrubbedUrl = url.replace(/[/\:?]/g, '_');
    const targetPath = path.join(downloadPath, 'file', scrubbedUrl);
    const marker = targetPath + '.completed';
    if (test('-f', marker)) {
        console.log('File already exists: ' + targetPath);
        return targetPath;
    }

    console.log('Downloading file: ' + url);
    // delete any previous partial attempt
    if (test('-f', targetPath)) {
        rm('-f', targetPath);
    }

    // download the file
    mkdir('-p', path.join(downloadPath, 'file'));
    const downloader = new Downloader({
        url: url,
        directory: path.join(downloadPath, 'file'),
        fileName: scrubbedUrl,
        maxAttempts: 3,
        timeout: 60000,
        onProgress: function (percentage, chunk, remainingSize) {
            // check that we run inside pipeline
            if (process.env['AGENT_TEMPDIRECTORY']) {
                console.log(`##vso[task.setprogress value=${percentage};]Downloading file: ${scrubbedUrl}`)
            }
        },
    });


    const { filePath } = await downloader.download(); // Downloader.download() resolves with some useful properties.
    fs.writeFileSync(marker, '');
    return filePath;
}
exports.downloadFileAsync = downloadFileAsync;

var downloadArchiveAsync = async function (url, omitExtensionCheck) {
    // validate parameters
    if (!url) {
        throw new Error('Parameter "url" must be set.');
    }

    var isZip;
    var isTargz;
    if (omitExtensionCheck) {
        isZip = true;
    }
    else {
        if (url.match(/\.zip$/)) {
            isZip = true;
        }
        else if (url.match(/\.tar\.gz$/) && (process.platform == 'darwin' || process.platform == 'linux')) {
            isTargz = true;
        }
        else {
            throw new Error('Unexpected archive extension');
        }
    }

    // skip if already downloaded and extracted
    var scrubbedUrl = url.replace(/[/\:?]/g, '_');

    var crypto = require('crypto');
    var newScrubbedUrl = crypto.createHash('sha256').update(scrubbedUrl).digest('hex');

    var targetPath = path.join(downloadPath, 'archive', newScrubbedUrl);
    var marker = targetPath + '.completed';
    if (!test('-f', marker)) {
        // download the archive
        var archivePath = await downloadFileAsync(url);
        console.log('Extracting archive: ' + url);

        // delete any previously attempted extraction directory
        if (test('-d', targetPath)) {
            rm('-rf', targetPath);
        }

        // extract
        mkdir('-p', targetPath);
        if (isZip) {
            if (process.platform == 'win32') {
                let escapedFile = archivePath.replace(/'/g, "''").replace(/"|\n|\r/g, ''); // double-up single quotes, remove double quotes and newlines
                let escapedDest = targetPath.replace(/'/g, "''").replace(/"|\n|\r/g, '');

                let command = `$ErrorActionPreference = 'Stop' ; try { Add-Type -AssemblyName System.IO.Compression.FileSystem } catch { } ; [System.IO.Compression.ZipFile]::ExtractToDirectory('${escapedFile}', '${escapedDest}')`;
                run(`powershell -Command "${command}"`);
            } else {
                run(`unzip ${archivePath} -d ${targetPath}`);
            }
        }
        else if (isTargz) {
            var originalCwd = process.cwd();
            cd(targetPath);
            try {
                run(`tar -xzf "${archivePath}"`);
            }
            finally {
                cd(originalCwd);
            }
        }

        // write the completed marker
        fs.writeFileSync(marker, '');
    }

    return targetPath;
}
exports.downloadArchiveAsync = downloadArchiveAsync;

var copyGroup = function (group, sourceRoot, destRoot) {
    // example structure to copy a single file:
    // {
    //   "source": "foo.dll"
    // }
    //
    // example structure to copy an array of files/folders to a relative directory:
    // {
    //   "source": [
    //     "foo.dll",
    //     "bar",
    //   ],
    //   "dest": "baz/",
    //   "options": "-R"
    // }
    //
    // example to multiply the copy by .NET culture names supported by TFS:
    // {
    //   "source": "<CULTURE_NAME>/foo.dll",
    //   "dest": "<CULTURE_NAME>/"
    // }
    //

    // validate parameters
    assert(group, 'group');
    assert(group.source, 'group.source');
    if (typeof group.source == 'object') {
        assert(group.source.length, 'group.source.length');
        group.source.forEach(function (s) {
            assert(s, 'group.source[i]');
        });
    }

    assert(sourceRoot, 'sourceRoot');
    assert(destRoot, 'destRoot');

    // multiply by culture name (recursive call to self)
    if (group.dest && group.dest.indexOf('<CULTURE_NAME>') >= 0) {
        var missingCultures = [];
        cultureNames.forEach(function (cultureName) {
            try {
                // culture names do not contain any JSON-special characters, so this is OK (albeit a hack)
                var localizedGroupJson = JSON.stringify(group).replace(/<CULTURE_NAME>/g, cultureName);
                copyGroup(JSON.parse(localizedGroupJson), sourceRoot, destRoot);
            }
            catch (err) {
                missingCultures.push(cultureName);
            }
        });

        // some cultures might not be present in certain dlls of TFS so just log and ignore
        // fail in case none were present, as this indicates programmer error (or should not be copied at all)
        if (missingCultures.length == cultureNames.length) {
            throw new Error('Could not find a single culture even though make was instructed to copy them.');
        }
        if (missingCultures.length > 0) {
            console.log('The following culture names could not be loaded as they do not exist: ' + missingCultures);
        }

        return;
    }

    // build the source array
    var source = typeof group.source == 'string' ? [group.source] : group.source;
    source = source.map(function (val) { // root the paths
        return path.join(sourceRoot, val);
    });

    // create the destination directory
    var dest = group.dest ? path.join(destRoot, group.dest) : destRoot + '/';
    dest = path.normalize(dest);
    mkdir('-p', dest);

    // copy the files
    if (group.hasOwnProperty('options') && group.options) {
        cp(group.options, source, dest);
    }
    else {
        cp(source, dest);
    }
}

var copyGroups = function (groups, sourceRoot, destRoot) {
    assert(groups, 'groups');
    assert(groups.length, 'groups.length');
    groups.forEach(function (group) {
        copyGroup(group, sourceRoot, destRoot);
    })
}
exports.copyGroups = copyGroups;

var removeGroup = function (group, pathRoot) {
    // example structure to remove an array of files/folders:
    // {
    //   "items": [
    //     "foo.dll",
    //     "bar",
    //   ],
    //   "options": "-R"
    // }

    // validate parameters
    assert(group, 'group');
    assert(group.items, 'group.items');
    if (typeof group.items != 'object') {
        throw new Error('Expected group.items to be an array');
    } else {
        assert(group.items.length, 'group.items.length');
        group.items.forEach(function (p) {
            assert(p, 'group.items[i]');
        });
    }

    assert(group.options, 'group.options');
    assert(pathRoot, 'pathRoot');

    // build the rooted items array
    var rootedItems = group.items.map(function (val) { // root the paths
        return path.join(pathRoot, val);
    });

    // remove the items
    rm(group.options, rootedItems);
}

var removeGroups = function (groups, pathRoot) {
    assert(groups, 'groups');
    assert(groups.length, 'groups.length');
    groups.forEach(function (group) {
        removeGroup(group, pathRoot);
    })
}
exports.removeGroups = removeGroups;

var addPath = function (directory) {
    console.log('');
    console.log(`> prepending PATH ${directory}`);

    var separator;
    if (os.platform() == 'win32') {
        separator = ';';
    }
    else {
        separator = ':';
    }

    var existing = process.env['PATH'];
    if (existing) {
        // move directory to top
        if (existing.indexOf(directory) !== -1) {
            existing = existing.replace(directory + separator, '');
        }
        process.env['PATH'] = directory + separator + existing;
    }
    else {
        process.env['PATH'] = directory;
    }
}
exports.addPath = addPath;

var getExternalsAsync = async function (externals, destRoot) {
    assert(externals, 'externals');
    assert(destRoot, 'destRoot');

    // .zip files
    if (externals.hasOwnProperty('archivePackages')) {
        var archivePackages = externals.archivePackages;
        for (const archive of archivePackages) {
            assert(archive.url, 'archive.url');
            assert(archive.dest, 'archive.dest');

            // download and extract the archive package
            var archiveSource = await downloadArchiveAsync(archive.url);

            // copy the files
            var archiveDest = path.join(destRoot, archive.dest);
            mkdir('-p', archiveDest);
            cp('-R', path.join(archiveSource, '*'), archiveDest);
        }
    }

    // external NuGet V2 packages
    if (externals.hasOwnProperty('nugetv2')) {
        var nugetPackages = externals.nugetv2;
        for (const package of nugetPackages) {
            // validate the structure of the data
            assert(package.name, 'package.name');
            assert(package.version, 'package.version');
            assert(package.repository, 'package.repository');
            assert(package.cp, 'package.cp');
            assert(package.cp, 'package.cp.length');

            // download and extract the NuGet V2 package
            var url = package.repository.replace(/\/$/, '') + '/package/' + package.name + '/' + package.version;
            var packageSource = await downloadArchiveAsync(url, /*omitExtensionCheck*/true);

            // If nuget doesn't find specific package version, it will download the latest.
            // We can't specify nuget to fail such request, so we need at least to check version post-factum.
            const parser = new XMLParser();

            const nuspecPath = path.join(packageSource, package.name + '.nuspec');
            const nuspecXml = fs.readFileSync(nuspecPath);
            const nuspec = parser.parse(nuspecXml);

            const nuspecVersion = nuspec && nuspec.package && nuspec.package.metadata && nuspec.package.metadata.version;
            if (nuspecVersion !== package.version) {
                fail(`Expected version '${package.version}' but got '${nuspecVersion}' for nuget package '${package.name}'`);
            }

            // copy specific files
            copyGroups(package.cp, packageSource, destRoot);
        }
    }

    // for any file type that has to be shipped with task
    if (externals.hasOwnProperty('files')) {
        var files = externals.files;
        for (const file of files) {
            assert(file.url, 'file.url');
            assert(file.dest, 'file.dest');

            // download the file from url
            var fileSource = await downloadFileAsync(file.url);
            // copy the files
            var fileDest = path.join(destRoot, file.dest);
            mkdir('-p', path.dirname(fileDest));
            cp(fileSource, fileDest);
        }
    }
}
exports.getExternalsAsync = getExternalsAsync;

//------------------------------------------------------------------------------
// task.json functions
//------------------------------------------------------------------------------
var fileToJson = function (file) {
    var jsonFromFile = JSON.parse(fs.readFileSync(file).toString());
    return jsonFromFile;
}
exports.fileToJson = fileToJson;

var createResjson = function (task, taskPath) {
    console.log(`createResjson ${taskPath}`);

    var resources = {};
    if (task.hasOwnProperty('friendlyName')) {
        resources['loc.friendlyName'] = task.friendlyName;
    }

    if (task.hasOwnProperty('helpMarkDown')) {
        resources['loc.helpMarkDown'] = task.helpMarkDown;
    }

    if (task.hasOwnProperty('description')) {
        resources['loc.description'] = task.description;
    }

    if (task.hasOwnProperty('instanceNameFormat')) {
        resources['loc.instanceNameFormat'] = task.instanceNameFormat;
    }

    if (task.hasOwnProperty('releaseNotes')) {
        resources['loc.releaseNotes'] = task.releaseNotes;
    }

    if (task.hasOwnProperty('groups')) {
        task.groups.forEach(function (group) {
            if (group.hasOwnProperty('name')) {
                resources['loc.group.displayName.' + group.name] = group.displayName;
            }
        });
    }

    if (task.hasOwnProperty('inputs')) {
        task.inputs.forEach(function (input) {
            if (input.hasOwnProperty('name')) {
                resources['loc.input.label.' + input.name] = input.label;

                if (input.hasOwnProperty('helpMarkDown') && input.helpMarkDown) {
                    resources['loc.input.help.' + input.name] = input.helpMarkDown;
                }
            }
        });
    }

    if (task.hasOwnProperty('messages')) {
        Object.keys(task.messages).forEach(function (key) {
            resources['loc.messages.' + key] = task.messages[key];
        });
    }

    var resjsonPath = path.join(taskPath, 'Strings', 'resources.resjson', 'en-US', 'resources.resjson');
    mkdir('-p', path.dirname(resjsonPath));
    var resjsonContent = JSON.stringify(resources, null, 2);
    if (process.platform == 'win32') {
        resjsonContent = resjsonContent.replace(/\n/g, os.EOL);
    }
    fs.writeFileSync(resjsonPath, resjsonContent);
};
exports.createResjson = createResjson;

var createTaskLocJson = function (taskPath) {
    var taskJsonPath = path.join(taskPath, 'task.json');
    var taskLoc = JSON.parse(fs.readFileSync(taskJsonPath));
    taskLoc.friendlyName = 'ms-resource:loc.friendlyName';
    taskLoc.helpMarkDown = 'ms-resource:loc.helpMarkDown';
    taskLoc.description = 'ms-resource:loc.description';
    taskLoc.instanceNameFormat = 'ms-resource:loc.instanceNameFormat';
    if (taskLoc.hasOwnProperty('releaseNotes')) {
        taskLoc.releaseNotes = 'ms-resource:loc.releaseNotes';
    }

    if (taskLoc.hasOwnProperty('groups')) {
        taskLoc.groups.forEach(function (group) {
            if (group.hasOwnProperty('name')) {
                group.displayName = 'ms-resource:loc.group.displayName.' + group.name;
            }
        });
    }

    if (taskLoc.hasOwnProperty('inputs')) {
        taskLoc.inputs.forEach(function (input) {
            if (input.hasOwnProperty('name')) {
                input.label = 'ms-resource:loc.input.label.' + input.name;

                if (input.hasOwnProperty('helpMarkDown') && input.helpMarkDown) {
                    input.helpMarkDown = 'ms-resource:loc.input.help.' + input.name;
                }
            }
        });
    }

    if (taskLoc.hasOwnProperty('messages')) {
        Object.keys(taskLoc.messages).forEach(function (key) {
            taskLoc.messages[key] = 'ms-resource:loc.messages.' + key;
        });
    }

    var taskLocContent = JSON.stringify(taskLoc, null, 2);
    if (process.platform == 'win32') {
        taskLocContent = taskLocContent.replace(/\n/g, os.EOL);
    }
    fs.writeFileSync(path.join(taskPath, 'task.loc.json'), taskLocContent);
};
exports.createTaskLocJson = createTaskLocJson;

// Validates the structure of a task.json file.
var validateTask = function (task) {
    if (!task.id || !check.isUUID(task.id)) {
        fail('id is a required guid');
    };

    if (!task.name || !check.isAlphanumeric(task.name)) {
        fail('name is a required alphanumeric string');
    }

    if (!task.friendlyName || !check.isLength(task.friendlyName, 1, 40)) {
        fail('friendlyName is a required string <= 40 chars');
    }

    if (!task.instanceNameFormat) {
        fail('instanceNameFormat is required');
    }
};
exports.validateTask = validateTask;
//------------------------------------------------------------------------------

//------------------------------------------------------------------------------
// Generate docs functions
//------------------------------------------------------------------------------
// Outputs a YAML snippet file for the specified task.
var createYamlSnippetFile = function (taskJson, docsDir, yamlOutputFilename) {
    var outFilePath = path.join(docsDir, yamlOutputFilename);
    fs.writeFileSync(outFilePath, getTaskYaml(taskJson));
}
exports.createYamlSnippetFile = createYamlSnippetFile;

var createMarkdownDocFile = function(taskJson, taskJsonPath, docsDir, mdDocOutputFilename) {
    var outFilePath = path.join(docsDir, taskJson.category.toLowerCase(), mdDocOutputFilename);
    if (!test('-e', path.dirname(outFilePath))) {
        fs.mkdirSync(path.dirname(outFilePath));
        fs.mkdirSync(path.join(path.dirname(outFilePath), '_img'));
    }

    var iconPath = path.join(path.dirname(taskJsonPath), 'icon.png');
    if (test('-f', iconPath)) {
        var docIconPath = path.join(path.dirname(outFilePath), '_img', cleanString(taskJson.name).toLowerCase() + '.png');
        fs.copyFileSync(iconPath, docIconPath);
    }

    fs.writeFileSync(outFilePath, getTaskMarkdownDoc(taskJson, mdDocOutputFilename));
}
exports.createMarkdownDocFile = createMarkdownDocFile;

// Returns a copy of the specified string with its first letter as a lowercase letter.
// Example: 'NachoLibre' -> 'nachoLibre'
function camelize(str) {
    return str.replace(/(?:^\w|[A-Z]|\b\w|\s+)/g, function(match, index) {
        return index == 0 ? match.toLowerCase() : match.toUpperCase();
    });
}

var getAliasOrNameForInputName = function(inputs, inputName) {
    var returnInputName = inputName;
    inputs.forEach(function(input) {
        if (input.name == inputName) {
            if (input.aliases && input.aliases.length > 0) {
                returnInputName = input.aliases[0];
            }
            else {
                returnInputName = input.name;
            }
        }
    });
    return camelize(returnInputName);
};

var getInputAliasOrName = function(input) {
    var returnInputName;
    if (input.aliases && input.aliases.length > 0) {
        returnInputName = input.aliases[0];
    }
    else {
        returnInputName = input.name;
    }
    return camelize(returnInputName);
};

var cleanString = function(str) {
    if (str) {
        return str
            .replace(/\r/g, '')
            .replace(/\n/g, '')
            .replace(/\"/g, '');
    }
    else {
        return str;
    }
}

var getTaskMarkdownDoc = function(taskJson, mdDocOutputFilename) {
    var taskMarkdown = '';

    taskMarkdown += '---' + os.EOL;
    taskMarkdown += 'title: ' + cleanString(taskJson.friendlyName) + os.EOL;
    taskMarkdown += 'description: ' + cleanString(taskJson.description) + os.EOL;
    taskMarkdown += 'ms.topic: reference' + os.EOL;
    taskMarkdown += 'ms.prod: devops' + os.EOL;
    taskMarkdown += 'ms.technology: devops-cicd' + os.EOL;
    taskMarkdown += 'ms.assetid: ' + taskJson.id + os.EOL;
    taskMarkdown += 'ms.manager: ' + os.userInfo().username + os.EOL;
    taskMarkdown += 'ms.author: ' + os.userInfo().username + os.EOL;
    taskMarkdown += 'ms.date: ' +
                    new Intl.DateTimeFormat('en-US', {year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date()) +
                    os.EOL;
    taskMarkdown += 'monikerRange: \'vsts\'' + os.EOL;
    taskMarkdown += '---' + os.EOL + os.EOL;

    taskMarkdown += '# ' + cleanString(taskJson.category) + ': ' + cleanString(taskJson.friendlyName) + os.EOL + os.EOL;
    taskMarkdown += '![](_img/' + cleanString(taskJson.name).toLowerCase() + '.png) ' + cleanString(taskJson.description) + os.EOL + os.EOL;

    taskMarkdown += '::: moniker range="> tfs-2018"' + os.EOL + os.EOL;
    taskMarkdown += '## YAML snippet' + os.EOL + os.EOL;
    taskMarkdown += '[!INCLUDE [temp](../_shared/yaml/' + mdDocOutputFilename + ')]' + os.EOL + os.EOL;
    taskMarkdown += '::: moniker-end' + os.EOL + os.EOL;

    taskMarkdown += '## Arguments' + os.EOL + os.EOL;
    taskMarkdown += '<table><thead><tr><th>Argument</th><th>Description</th></tr></thead>' + os.EOL;
    taskJson.inputs.forEach(function(input) {
        var requiredOrNot = input.required ? 'Required' : 'Optional';
        var label = cleanString(input.label);
        var description = input.helpMarkDown; // Do not clean white space from descriptions
        taskMarkdown += '<tr><td>' + label + '</td><td>(' + requiredOrNot + ') ' + description + '</td></tr>' + os.EOL;
    });

    taskMarkdown += '[!INCLUDE [temp](../_shared/control-options-arguments.md)]' + os.EOL;
    taskMarkdown += '</table>' + os.EOL + os.EOL;

    taskMarkdown += '## Q&A' + os.EOL + os.EOL;
    taskMarkdown += '<!-- BEGINSECTION class="md-qanda" -->' + os.EOL + os.EOL;
    taskMarkdown += '<!-- ENDSECTION -->' + os.EOL;

    return taskMarkdown;
}

var getTaskYaml = function(taskJson) {
    var taskYaml = '';
    taskYaml += '```YAML' + os.EOL;
    taskYaml += '# ' + cleanString(taskJson.friendlyName) + os.EOL;
    taskYaml += '# ' + cleanString(taskJson.description) + os.EOL;
    taskYaml += '- task: ' + taskJson.name + '@' + taskJson.version.Major + os.EOL;
    taskYaml += '  inputs:' + os.EOL;

    taskJson.inputs.forEach(function(input) {
        // Is the input required?
        var requiredOrNot = input.required ? '' : '# Optional';
        if (input.required && input.visibleRule && input.visibleRule.length > 0) {
            var spaceIndex = input.visibleRule.indexOf(' ');
            var visibleRuleInputName = input.visibleRule.substring(0, spaceIndex);
            var visibleRuleInputNameCamel = camelize(visibleRuleInputName);
            requiredOrNot += '# Required when ' + camelize(input.visibleRule)
            .replace(/ = /g, ' == ')
            .replace(visibleRuleInputNameCamel, getAliasOrNameForInputName(taskJson.inputs, visibleRuleInputName));
        }

        // Does the input have a default value?
        var isDefaultValueAvailable = input.defaultValue && (input.defaultValue.length > 0 || input.type == 'boolean');
        var defaultValue = isDefaultValueAvailable ? input.defaultValue.toString() : null;

        // Comment out the input?
        if (!input.required ||
            (input.required && isDefaultValueAvailable) ||
            (input.visibleRule && input.visibleRule.length > 0)) {
            taskYaml += '    #';
        }
        else {
            taskYaml += '    ';
        }

        // Append input name
        taskYaml += getInputAliasOrName(input) + ': ';

        // Append default value
        if (defaultValue) {
            if (input.type == 'boolean') {
                taskYaml += cleanString(defaultValue) + ' ';
            }
            else {
                taskYaml += '\'' + cleanString(defaultValue) + '\' ';
            }
        }

        // Append required or optional
        taskYaml += requiredOrNot;

        // Append options?
        if (input.options) {
            var isFirstOption = true;
            Object.keys(input.options).forEach(function(key) {
                if (isFirstOption) {
                    taskYaml += (input.required ? '# ' : '. ') + 'Options: ' + camelize(cleanString(key));
                    isFirstOption = false;
                }
                else {
                    taskYaml += ', ' + camelize(cleanString(key));
                }
            });
        }

        // Append end-of-line for the input
        taskYaml += os.EOL;
    });

    // Append endings
    taskYaml += '```' + os.EOL;

    return taskYaml;
};
//------------------------------------------------------------------------------

//------------------------------------------------------------------------------
// package functions
//------------------------------------------------------------------------------
var linkNonAggregatedLayoutContent = function (sourceRoot, destRoot, metadataOnly) {
    assert(sourceRoot, 'sourceRoot');
    assert(destRoot, 'destRoot');
    var metadataFileNames = ['TASK.JSON', 'TASK.LOC.JSON', 'STRINGS', 'ICON.PNG'];
    // process each file/folder within the source root
    fs.readdirSync(sourceRoot).forEach(function (itemName) {
        var taskSourcePath = path.join(sourceRoot, itemName);
        var taskDestPath = path.join(destRoot, itemName);

        // skip the Common folder and skip files
        if (itemName == 'Common' || !fs.statSync(taskSourcePath).isDirectory()) {
            return;
        }

        mkdir('-p', taskDestPath);

        // process each file/folder within each task folder
        fs.readdirSync(taskSourcePath).forEach(function (itemName) {
            // skip the Tests folder
            if (itemName == 'Tests') {
                return;
            }

            // when metadataOnly=true, skip non-metadata items
            if (metadataOnly && metadataFileNames.indexOf(itemName.toUpperCase()) < 0) {
                return;
            }

            // create a junction point for directories, hardlink files
            var itemSourcePath = path.join(taskSourcePath, itemName);
            var itemDestPath = path.join(taskDestPath, itemName);
            if (fs.statSync(itemSourcePath).isDirectory()) {
                fs.symlinkSync(itemSourcePath, itemDestPath, 'junction');
            }
            else {
                fs.linkSync(itemSourcePath, itemDestPath);
            }
        });
    });
}

var linkAggregatedLayoutContent = function (sourceRoot, destRoot, release, commit, taskDestMap) {
    assert(sourceRoot, 'sourceRoot');
    assert(destRoot, 'destRoot');
    assert(commit, 'commit');
    console.log();
    console.log(`> Linking ${path.basename(sourceRoot)}`);
    mkdir('-p', destRoot);

    // process each file/folder within the non-aggregated layout
    fs.readdirSync(sourceRoot).forEach(function (itemName) {
        // skip files
        var taskSourcePath = path.join(sourceRoot, itemName);
        if (!fs.statSync(taskSourcePath).isDirectory()) {
            return;
        }

        // load the source task.json
        var sourceTask = JSON.parse(fs.readFileSync(path.join(taskSourcePath, 'task.json')));
        if (typeof sourceTask.version.Major != 'number' ||
            typeof sourceTask.version.Minor != 'number' ||
            typeof sourceTask.version.Patch != 'number') {

            fail(`Expected task.version.Major/Minor/Patch to be numbers (${taskSourcePath})`);
        }

        // determine the dest folder based on the major version
        assert(sourceTask.id, 'sourceTask.id');
        var taskDestKey = sourceTask.id + '@' + sourceTask.version.Major;
        var taskDestPath = taskDestMap[taskDestKey];
        if (!taskDestPath) {
            taskDestPath = path.join(destRoot, itemName + `__v${sourceTask.version.Major}`);
            taskDestMap[taskDestKey] = taskDestPath;
        }

        if (test('-e', taskDestPath)) {
            // validate that a newer minor+patch does not exist in an older release
            // (newer releases should be linked first)
            var destTask = JSON.parse(fs.readFileSync(path.join(taskDestPath, 'task.json')));
            var sourceVersion = `${sourceTask.version.Major}.${sourceTask.version.Minor}.${sourceTask.version.Patch}`;
            var destVersion = `${destTask.version.Major}.${destTask.version.Minor}.${destTask.version.Patch}`;
            if (semver.gt(sourceVersion, destVersion)) {
                fail(`Expected minor+patch version for task already in the aggregate layout, to be greater or equal than non-aggregated layout being merged. Source task: ${taskSourcePath}`);
            }
        }
        else {
            // create a junction point
            fs.symlinkSync(taskSourcePath, taskDestPath, 'junction');

            // write a human-friendly metadata file
            fs.writeFileSync(taskDestPath + (release ? `_m${release}` : '') + `_${commit}`, '');
        }
    });
}

var getNonAggregatedLayout = function (packagePath, release, commit) {
    assert(packagePath, 'packagePath');
    assert(release, 'release');
    assert(commit, 'commit');

    // validate the zip is in the cache
    var localappdata = process.env.LOCALAPPDATA;
    assert(localappdata, 'LOCALAPPDATA');
    var zipPath = path.join(localappdata, 'vsts-tasks', `non-aggregated-tasks_m${release}_${commit}.zip`);
    var markerPath = `${zipPath}.completed`;
    if (!test('-f', markerPath)) {
        fail(`Non-aggregated layout for m${release} (${commit}) not found in the cache. Publish the latest m${release} and then try again.`);
    }

    // extract
    console.log();
    console.log(`> Expanding ${path.basename(zipPath)}`);
    var destPath = path.join(packagePath, `non-aggregated-layout-m${release}`);
    run(`powershell.exe -NoLogo -Sta -NoProfile -NonInteractive -ExecutionPolicy Unrestricted -Command "& '${path.join(__dirname, 'Expand-Tasks.ps1')}' -ZipPath '${zipPath}' -TargetPath '${destPath}'"`, /*inheritStreams:*/false, /*noHeader*/true);

    return destPath;
}

var getRefs = function () {
    console.log();
    console.log('> Getting branch/commit info')
    var info = {};
    var branch;
    if (process.env.TF_BUILD) {
        // during CI agent checks out a commit, not a branch.
        // $(build.sourceBranch) indicates the branch name, e.g. releases/m108
        branch = process.env.BUILD_SOURCEBRANCH;
    }
    else {
        // assumes user has checked out a branch. this is a fairly safe assumption.
        // this code only runs during "package" and "publish" build targets, which
        // is not typically run locally.
        branch = run('git symbolic-ref HEAD', /*inheritStreams*/false, /*noHeader*/true);
    }

    assert(branch, 'branch');
    var commit = run('git rev-parse --short=8 HEAD', /*inheritStreams*/false, /*noHeader*/true);
    var release;
    if (branch.match(/^(refs\/heads\/)?releases\/m[0-9]+$/)) {
        release = parseInt(branch.split('/').pop().substr(1));
    }

    // get the ref info for HEAD
    var info = {
        head: {
            branch: branch,  // e.g. refs/heads/releases/m108
            commit: commit,  // leading 8 chars only
            release: release // e.g. 108 or undefined if not a release branch
        },
        releases: {}
    };

    // get the ref info for each release branch within range
    run('git branch --list --remotes "origin/releases/m*"', /*inheritStreams*/false, /*noHeader*/true)
        .split('\n')
        .forEach(function (branch) {
            branch = branch.trim();
            if (!branch.match(/^origin\/releases\/m[0-9]+$/)) {
                return;
            }

            var release = parseInt(branch.split('/').pop().substr(1));

            // filter out releases less than 108 and greater than HEAD
            if (release < 108 ||
                release > (info.head.release || 999)) {

                return;
            }

            branch = 'refs/remotes/' + branch;
            var commit = run(`git rev-parse --short=8 "${branch}"`, /*inheritStreams*/false, /*noHeader*/true);
            info.releases[release] = {
                branch: branch,
                commit: commit,
                release: release
            };
        });

    return info;
}
exports.getRefs = getRefs;

var compressTasks = function (sourceRoot, destPath, individually) {
    assert(sourceRoot, 'sourceRoot');
    assert(destPath, 'destPath');
    run(`powershell.exe -NoLogo -Sta -NoProfile -NonInteractive -ExecutionPolicy Unrestricted -Command "& '${path.join(__dirname, 'Compress-Tasks.ps1')}' -SourceRoot '${sourceRoot}' -TargetPath '${destPath}' -Individually:${individually ? '$true' : '$false'}"`, /*inheritStreams:*/true, /*noHeader*/true);
}
exports.compressTasks = compressTasks;

var createNonAggregatedZip = function (buildPath, packagePath) {
    console.log();
    console.log('> Creating non aggregate zip');
    assert(buildPath, 'buildPath');
    assert(packagePath, 'packagePath');

    // build the layout for the nested task zips
    console.log();
    console.log('> Linking content for nested task zips');
    var nestedZipsContentPath = path.join(packagePath, 'nested-zips-layout');
    linkNonAggregatedLayoutContent(buildPath, nestedZipsContentPath, /*metadataOnly*/false);

    // create the nested task zips (part of the non-aggregated tasks layout)
    console.log();
    console.log('> Creating nested task zips (content for non-aggregated tasks layout)');
    var nonAggregatedLayoutPath = path.join(packagePath, 'non-aggregated-layout');
    compressTasks(nestedZipsContentPath, nonAggregatedLayoutPath, /*individually:*/true);

    // link the task metadata into the non-aggregated tasks layout
    console.log();
    console.log('> Linking metadata content for non-aggregated tasks layout');
    linkNonAggregatedLayoutContent(buildPath, nonAggregatedLayoutPath, /*metadataOnly*/true);

    // mark the layout with a version number.
    // servicing supports both this new format and the legacy layout format as well.
    fs.writeFileSync(path.join(nonAggregatedLayoutPath, 'layout-version.txt'), '2');

    // create the non-aggregated tasks zip
    console.log();
    console.log('> Zipping non-aggregated tasks layout');
    var nonAggregatedZipPath = path.join(packagePath, 'non-aggregated-tasks.zip');
    compressTasks(nonAggregatedLayoutPath, nonAggregatedZipPath);

    return nonAggregatedLayoutPath;
}
exports.createNonAggregatedZip = createNonAggregatedZip;

/**
 * Create a NuGet package per task. This function assumes the tasks are already laid out on disk.
 *
 * When running locally, layoutPath is something like: _package\non-aggregated-layout
 * Within this folder we have one of these folders per task:
 *  /CmdLineV2
 *      /Strings
 *      /task.json
 *      /task.loc.json
 *      /task.zip
 *
 * Within the function we create an artifacts folder, this is what gets uploaded when we are done.
 * The contents look something like:
 * /artifacts
 *  /AndroidSigningV2
 *      /Mseng.MS.TF.DistributedTask.Tasks.AndroidSigningV2.2.135.0.nupkg
 *  /AnotherTask
 *      /Mseng.MS.TF.DistributedTask.Tasks.AnotherTaskV1.1.0.0.nupkg
 *  /servicing.xml * Convenience file. Generates all XML to update servicing configuration for tasks.
 *  /unified_deps.xml * Convenience file. Generates all XML to update unified dependencies file.
 *
 * @param {*} packagePath Path of _packages folder.
 * @param {*} layoutPath Path that has task layouts.
 */
var createNugetPackagePerTask = function (packagePath, /*nonAggregatedLayoutPath*/layoutPath) {
    console.log();
    console.log('> Creating NuGet package per task')

    // create folder for _package\task-zips
    // Inside this folder we have one folder per task that contains the task.zip.
    // It also has layout-version.txt and the nuspec file for the task.
    // This folder is what we create the nupkg from.
    console.log();
    console.log('> Creating task zips folder');
    var tasksZipsPath = path.join(packagePath, 'task-zips');
    mkdir('-p', tasksZipsPath);

    // _package\nuget-packages
    // This is the final state of the task content and what is published as a build artifact.
    console.log();
    console.log('> Creating artifacts folder');
    var nugetPackagesPath = path.join(packagePath, "nuget-packages");
    mkdir('-p', nugetPackagesPath);

    console.log();
    console.log('> Zipping task folders')

    // maintain package references that we need to add to unified dependencies
    var unifiedDepsContent = [];

    // maintain xml content for adding packages to servicing configuration
    var servicingXmlContent = [];

    // iterate all the tasks
    fs.readdirSync(layoutPath)
        .forEach(function (taskFolderName) {
            // The non-aggregated-layout folder has a layout-version in it, skip when we hit it.
            if (taskFolderName === 'layout-version.txt') {
                return;
            }

            var taskLayoutPath = path.join(layoutPath, taskFolderName);
            var taskJsonPath = path.join(taskLayoutPath, 'task.json');
            var taskJsonContents = JSON.parse(fs.readFileSync(taskJsonPath));
            var taskVersion = taskJsonContents.version.Major + '.' + taskJsonContents.version.Minor + '.' + taskJsonContents.version.Patch;
            var taskName = taskJsonContents.name;

            // Create the full task name so we don't need to rely on the folder name.
            var fullTaskName = `Mseng.MS.TF.DistributedTask.Tasks.${taskName}V${taskJsonContents.version.Major}`;
            if (taskJsonContents.hasOwnProperty('_buildConfigMapping')) {
                for (let i in taskJsonContents._buildConfigMapping) {
                    if (taskJsonContents._buildConfigMapping[i] === taskVersion && i.toLocaleLowerCase() !== 'default') {
                        // take only first part of the name
                        var postfix = i.split('-')[0];
                        fullTaskName = fullTaskName + `_${postfix}`;
                        break;
                    }
                }
            }
            // Create xml entry for UnifiedDependencies
            unifiedDepsContent.push(`  <PackageVersion Include="${fullTaskName}" Version="${taskVersion}" AvailableAtDeployTime="true" />`);

            // Create xml entry that we need to configure servicing file
            servicingXmlContent.push(getServicingXmlContent(taskFolderName, fullTaskName, taskVersion));

            // Create a matching folder inside taskZipsPath
            var taskZipPath = path.join(tasksZipsPath, taskFolderName);
            mkdir('-p', taskZipPath);
            console.log('root task folder: ' + taskZipPath);

            // Following NuGet conventions, we want the NuGet content to go inside a content folder
            // Our task.zip and layout-version.txt will go inside the content folder
            var nugetContentPath = path.join(taskZipPath, 'content');
            mkdir('-p', nugetContentPath);

            // hard link task.zip from layout to nuget contents
            var layoutZipPath = path.join(taskLayoutPath, 'task.zip');
            var nugetContentsZipPath = path.join(nugetContentPath, 'task.zip');
            fs.linkSync(layoutZipPath, nugetContentsZipPath);

            // Write layout version file. This will help us if we change the structure of the individual NuGet packages in the future.
            fs.writeFileSync(path.join(nugetContentPath, 'layout-version.txt'), '3');

            // Create the nuspec file and nupkg
            var taskNuspecPath = createNuspecFile(taskZipPath, fullTaskName, taskVersion);
            createNuGetPackage(nugetPackagesPath, taskFolderName, taskNuspecPath, taskZipPath);
        });

    console.log();

    // Write file that has XML for unified dependencies, makes it easier to setup that file.
    console.log('> Generating XML dependencies for UnifiedDependencies');
    var depsContentPath = path.join(nugetPackagesPath, 'unified_deps.xml');
    fs.writeFileSync(depsContentPath, unifiedDepsContent.sort(function (a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); }).join(os.EOL));

    // Write file that has XML for servicing, makes it easier to setup that file.
    console.log('> Generating XML dependencies for Servicing');
    var servicingContentPath = path.join(nugetPackagesPath, 'servicing.xml');
    fs.writeFileSync(servicingContentPath, servicingXmlContent.sort(function (a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); }).join(''));
}
exports.createNugetPackagePerTask = createNugetPackagePerTask;


/**
 * Create xml content for servicing.
 *
 * e.g. -
 * <Directory Path="[ServicingDir]Tasks\Individual\AndroidSigningV2\">
 *   <File Origin="nuget://Mseng.MS.TF.DistributedTask.Tasks.AndroidSigningV2/*" />
 * </Directory>
 *
 * @param {*} taskFolderName
 * @param {*} fullTaskName
 * @param {*} taskVersion
 */
var getServicingXmlContent = function (taskFolderName, fullTaskName, taskVersion) {
    var servicingXmlContent = '';

    servicingXmlContent += `  <Directory Path="[ServicingDir]Tasks\\Individual\\${taskFolderName}\\">` + os.EOL;
    servicingXmlContent += `    <File Origin="nuget://${fullTaskName}/*" />` + os.EOL;
    servicingXmlContent += `  </Directory>` + os.EOL;

    return servicingXmlContent;
}

/**
 * Create .nuspec file for a task.
 *
 * @param {*} taskLayoutPath Layout path for the specific task we are creating nuspec for
 * @param {*} fullTaskName Full name of the task. e.g. - Mseng.MS.TF.DistributedTask.Tasks.AzureCLIV1
 * @param {*} taskVersion Version of the task. e.g. - 1.132.0
 * @returns Path of the nuspec file that was created.
 */
var createNuspecFile = function (taskLayoutPath, fullTaskName, taskVersion) {
    console.log('> Creating nuspec file');

    var contents = '<?xml version="1.0" encoding="utf-8"?>' + os.EOL;
    contents += '<package xmlns="http://schemas.microsoft.com/packaging/2010/07/nuspec.xsd">' + os.EOL;
    contents += '   <metadata>' + os.EOL;
    contents += '      <id>' + fullTaskName + '</id>' + os.EOL;
    contents += '      <version>' + taskVersion + '</version>' + os.EOL;
    contents += '      <authors>bigbldt</authors>' + os.EOL;
    contents += '      <owners>bigbldt,Microsoft</owners>' + os.EOL;
    contents += '      <requireLicenseAcceptance>false</requireLicenseAcceptance>' + os.EOL;
    contents += '      <description>For VSS internal use only</description>' + os.EOL;
    contents += '      <tags>VSSInternal</tags>' + os.EOL;
    contents += '   </metadata>' + os.EOL;
    contents += '</package>' + os.EOL;

    var taskNuspecPath = path.join(taskLayoutPath, fullTaskName + '.nuspec');
    console.log('taskNuspecPath: ' + taskNuspecPath);
    fs.writeFileSync(taskNuspecPath, contents);

    return taskNuspecPath;
}

/**
 * Create .nupkg for a specific task.
 * @param {*} publishPath Root path to publish tasks.
 * @param {*} taskFolderName Folder name for the task we want to create a NuGet package for. e.g - AzurePowerShellV3
 * @param {*} taskNuspecPath Path to existing Nuspec file. This is inside the layout folder for the task. e.g - _package\per-task-layout\AzureCLIV1\Mseng.MS.TF.DistributedTask.Tasks.AzureCLIV1.nuspec
 * @param {*} taskLayoutPath Path where contents of a specific task are laid out on disk.
 * @returns Publish folder for the task.
 */
var createNuGetPackage = function (publishPath, taskFolderName, taskNuspecPath, taskLayoutPath) {
    console.log('> Creating nuget package for task ' + taskFolderName);

    var taskPublishFolder = path.join(publishPath, taskFolderName);
    fs.mkdirSync(taskPublishFolder);
    process.chdir(taskPublishFolder);

    console.log('task nuspec path: ' + taskNuspecPath);
    console.log('base path: ' + taskLayoutPath)
    run(`nuget pack "${taskNuspecPath}" -BasePath "${taskLayoutPath}" -NoDefaultExcludes`, /*inheritStreams:*/ true);

    return taskPublishFolder;
}


// Rename task folders that are created from the aggregate. Allows NuGet generation from aggregate using same process as normal.
// [stfrance]: remove this once we have fully migrated to nuget package per task.
var renameFoldersFromAggregate = function renameFoldersFromAggregate(pathWithLegacyFolders) {
    // Rename folders
    fs.readdirSync(pathWithLegacyFolders)
        .forEach(function (taskFolderName) {
            if (taskFolderName.charAt(taskFolderName.length-1) === taskFolderName.charAt(taskFolderName.length-3)
                && taskFolderName.charAt(taskFolderName.length-2) === taskFolderName.charAt(taskFolderName.length-4))
            {
                var currentPath = path.join(pathWithLegacyFolders, taskFolderName);
                var newPath = path.join(pathWithLegacyFolders, taskFolderName.substring(0, taskFolderName.length - 2));

                fs.renameSync(currentPath, newPath);
            }

            var currentPath = path.join(pathWithLegacyFolders, taskFolderName);
            if (taskFolderName.indexOf('__') !== -1) {
                var s = taskFolderName.split('__');
                var newFolderName = s[0] + s[1].toUpperCase();
                var newPath = path.join(pathWithLegacyFolders, newFolderName);

                fs.renameSync(currentPath, newPath);
            }
        });
}
exports.renameFoldersFromAggregate = renameFoldersFromAggregate;

// Use the main layout process on Task folders that were extracted from the aggregate.
// This is what we use to seed packaging with older major versions.
// [stfrance]: remove this once we have fully migrated to nuget package per task.
var generatePerTaskForLegacyPackages = function generatePerTaskForLegacyPackages(pathWithLegacyFolders) {
    // Generate NuGet package per task for legacy packages.
    var legacyPath = path.join(__dirname, '_packageLegacy');
    if (test('-d', legacyPath)) {
        rm('-rf', legacyPath);
    }

    createNugetPackagePerTask(legacyPath, pathWithLegacyFolders);
}
exports.generatePerTaskForLegacyPackages = generatePerTaskForLegacyPackages;

// TODO: Do we need to fix this?
var createHotfixLayout = function (packagePath, taskName) {
    assert(packagePath, 'packagePath');
    assert(taskName, 'taskName');
    console.log();
    console.log(`> Creating hotfix layout for task '${taskName}'`);

    var branch = null;
    if (process.env.TF_BUILD) {
        // during CI agent checks out a commit, not a branch.
        // $(build.sourceBranch) indicates the branch name, e.g. releases/m108
        branch = process.env.BUILD_SOURCEBRANCH;
    }
    else {
        // assumes user has checked out a branch. this is a fairly safe assumption.
        // this code only runs during "package" and "publish" build targets, which
        // is not typically run locally.
        branch = run('git symbolic-ref HEAD', /*inheritStreams*/false, /*noHeader*/true);
    }

    var commitInfo = run('git log -1 --format=oneline', /*inheritStreams*/false, /*noHeader*/true);

    // create the script
    var hotfixPath = path.join(packagePath, 'hotfix');
    mkdir('-p', hotfixPath);
    var scriptPath = path.join(hotfixPath, `${taskName}.ps1`);
    var scriptContent = '# Hotfix created from branch: ' + branch + os.EOL;
    scriptContent += '# Commit: ' + commitInfo + os.EOL;
    scriptContent += '$ErrorActionPreference=\'Stop\'' + os.EOL;
    scriptContent += 'Update-DistributedTaskDefinitions -TaskZip $PSScriptRoot\\tasks.zip' + os.EOL;
    fs.writeFileSync(scriptPath, scriptContent);

    // link the non-aggregated tasks zip
    var zipSourcePath = path.join(packagePath, 'non-aggregated-tasks.zip');
    var zipDestPath = path.join(hotfixPath, 'tasks.zip');
    cp(zipSourcePath, zipDestPath);
}
exports.createHotfixLayout = createHotfixLayout;

var createAggregatedZip = function (packagePath) {
    assert(packagePath, 'packagePath');

    // get branch/commit info
    var refs = getRefs();

    // initialize the aggregated layout
    // mark the layout with a version number.
    // servicing supports both this new format and the legacy layout format as well.
    console.log();
    console.log('> Creating aggregated layout');
    var aggregatedLayoutPath = path.join(packagePath, 'aggregated-layout');
    mkdir('-p', aggregatedLayoutPath);
    fs.writeFileSync(path.join(aggregatedLayoutPath, 'layout-version.txt'), '2');

    // track task GUID + major version -> destination path
    // task directory names can change between different release branches
    var taskDestMap = {};

    // link the tasks from the non-aggregated layout into the aggregated layout
    var nonAggregatedLayoutPath = path.join(packagePath, 'non-aggregated-layout');
    linkAggregatedLayoutContent(nonAggregatedLayoutPath, aggregatedLayoutPath, /*release:*/'', /*commit:*/refs.head.commit, taskDestMap);

    // link the tasks from previous releases into the aggregated layout
    Object.keys(refs.releases)
        .sort()
        .reverse()
        .forEach(function (release) {
            // skip the current release (already covered by current build)
            if (release == refs.head.release) {
                return;
            }

            var commit = refs.releases[release].commit;
            var releaseLayout = getNonAggregatedLayout(packagePath, release, commit);
            linkAggregatedLayoutContent(releaseLayout, aggregatedLayoutPath, /*release:*/release, /*commit:*/commit, taskDestMap);
        });

    // validate task uniqueness within the layout based on task GUID + major version
    var majorVersions = {};
    fs.readdirSync(aggregatedLayoutPath) // walk each item in the aggregate layout
        .forEach(function (itemName) {
            var itemPath = path.join(aggregatedLayoutPath, itemName);
            if (!fs.statSync(itemPath).isDirectory()) { // skip files
                return;
            }

            // load the task.json
            var taskPath = path.join(itemPath, 'task.json');
            var task = JSON.parse(fs.readFileSync(taskPath));
            if (typeof task.version.Major != 'number') {
                fail(`Expected task.version.Major/Minor/Patch to be a number (${taskPath})`);
            }

            assert(task.id, `task.id (${taskPath})`);
            if (typeof task.id != 'string') {
                fail(`Expected id to be a string (${taskPath})`);
            }

            // validate GUID + Major version is unique
            var key = task.id + task.version.Major;
            if (majorVersions[key]) {
                fail(`Tasks GUID + Major version must be unique within the aggregated layout. Task 1: ${majorVersions[key]}; task 2: ${taskPath}`);
            }

            majorVersions[key] = taskPath;
        });

    // create the aggregated tasks zip
    console.log();
    console.log('> Zipping aggregated tasks layout');
    var aggregatedZipPath = path.join(packagePath, 'pack-source', 'contents', 'Microsoft.TeamFoundation.Build.Tasks.zip');
    mkdir('-p', path.dirname(aggregatedZipPath));
    compressTasks(aggregatedLayoutPath, aggregatedZipPath);
}
exports.createAggregatedZip = createAggregatedZip;

var storeNonAggregatedZip = function (zipPath, release, commit) {
    assert(zipPath, 'zipPath');
    ensureExists(zipPath);
    assert(release, 'release');
    assert(commit, 'commit');

    console.log();
    console.log(`> Storing non-aggregated zip (m${release} ${commit})`);

    // determine the destination dir
    var localappdata = process.env.LOCALAPPDATA;
    assert(localappdata, 'LOCALAPPDATA');
    var destDir = path.join(localappdata, 'vsts-tasks');
    mkdir('-p', destDir);

    // remove old packages for same release branch
    rm(path.join(destDir, `non-aggregated-tasks_m${release}_*`))

    // copy the zip
    var destZip = path.join(destDir, `non-aggregated-tasks_m${release}_${commit}.zip`);
    cp(zipPath, destZip);

    // write the completed marker file
    var destMarker = `${destZip}.completed`;
    fs.writeFileSync(destMarker, '');
}
exports.storeNonAggregatedZip = storeNonAggregatedZip;

const getTaskNodeVersion = function(buildPath, taskName) {
    const fallbackNode = 20;
    const nodes = new Set();
    const taskJsonPath = path.join(buildPath, taskName, "task.json");
    if (!fs.existsSync(taskJsonPath)) {
        console.warn(`Unable to find task.json, defaulting to use Node ${fallbackNode}`);
        nodes.add(fallbackNode);
        return Array.from(nodes);
    }

    const taskJsonContents = fs.readFileSync(taskJsonPath, { encoding: 'utf-8' });
    const taskJson = JSON.parse(taskJsonContents);

    const executors = ['execution', 'prejobexecution', 'postjobexecution'];
    for (const executor of executors) {
        if (!taskJson[executor]) continue;

        for (const key of Object.keys(taskJson[executor])) {
            const currExecutor = key.toLocaleLowerCase();
            if (!currExecutor.startsWith('node')) continue;
            const version = currExecutor.replace('node', '');
            nodes.add(parseInt(version) || fallbackNode);
        }
    }

    if (nodes.size) {
        return Array.from(nodes);
    }

    console.warn(`Unable to determine execution type from task.json, defaulting to use Node ${fallbackNode} taskName=${taskName}`);
    nodes.add(fallbackNode);
    return Array.from(nodes);
}
exports.getTaskNodeVersion = getTaskNodeVersion;

/**
 *
 * @param {String} buildPath - Path to the build folder
 * @param {String} taskName - Name of the task
 * @returns { Boolean } true if the task is a node task
 */
var isNodeTask = function(buildPath, taskName) {
    const taskJsonPath = path.join(buildPath, taskName, "task.json");
    if (!fs.existsSync(taskJsonPath)) return false;

    const taskJsonContents = fs.readFileSync(taskJsonPath, { encoding: 'utf-8' });
    const taskJson = JSON.parse(taskJsonContents);
    const execution = ['execution', 'prejobexecution','postjobexecution']
        .map(key => taskJson[key]);

    for (const executors of execution) {
        if (!executors) continue;
        for (const key of Object.keys(executors)) {
            const executor = key.toLocaleLowerCase();
            if (executor.startsWith('node')) return true;
        }
    }

    return false;
}
exports.isNodeTask = isNodeTask;

//------------------------------------------------------------------------------

function renameCodeCoverageOutput(coveragePath, taskName) {
    if (!coveragePath) return;
    try {
        if (fs.existsSync(coveragePath)) {
            if (fs.existsSync(path.join(coveragePath, "coverage-final.json"))) {
                fs.renameSync(path.join(coveragePath, "coverage-final.json"), path.join(coveragePath, `${taskName}-coverage.json`));
            }
            if (fs.existsSync(path.join(coveragePath, "coverage-summary.json"))) {
                fs.renameSync(path.join(coveragePath, "coverage-summary.json"), path.join(coveragePath, `${taskName}-coverage-summary.json`));
            }
        }
    } catch (e) {
        console.log(e)
    }
}
exports.renameCodeCoverageOutput = renameCodeCoverageOutput;
//------------------------------------------------------------------------------
// codegen functions
//------------------------------------------------------------------------------

/**
 * Ensure Pre-reqs for buildConfigGen (e.g. dotnet)
 * @param {String} baseConfigToolPath base build config tool path
 */
var ensureBuildConfigGeneratorPrereqs = function (baseConfigToolPath) {
    var configToolBuildUtility = "";

    if (os.platform() === 'win32') {
        configToolBuildUtility = path.join(baseConfigToolPath, "dev.cmd");
    } else {
        configToolBuildUtility = path.join(baseConfigToolPath, "dev.sh");
    }

    const dotnetSdkVersion = "8.0.100";
    const dotnetInstallationDirectory = path.resolve(baseConfigToolPath, "_dotnetsdk", dotnetSdkVersion);

    // build configToolBuildUtility if needed.  (up-to-date check will skip build if not needed)
    run(`${configToolBuildUtility} ${baseConfigToolPath} ${dotnetInstallationDirectory} ${dotnetSdkVersion}`, true);
    addPath(dotnetInstallationDirectory);
};
exports.ensureBuildConfigGeneratorPrereqs = ensureBuildConfigGeneratorPrereqs;

/**
 * Function to validate or write generated tasks
 * @param {String} baseConfigToolPath Path to generating program
 * @param {Array} taskList  Array with allowed tasks
 * @param {Object} makeOptions Object with all tasks
 * @param {Boolean} writeUpdates Write Updates (false to validateOnly)
 * @param {Number} sprintNumber Sprint number option to pass in the BuildConfigGenerator tool
 * @param {String} debugAgentDir When set to local agent root directory, the BuildConfigGenerator tool will generate launch configurations for the task(s)
 * @param {Boolean} includeLocalPackagesBuildConfig When set to true, generate LocalPackages BuildConfig
 */
var processGeneratedTasks = function(baseConfigToolPath, taskList, makeOptions, writeUpdates, sprintNumber, debugAgentDir, includeLocalPackagesBuildConfig) {
    if (!makeOptions) fail("makeOptions is not defined");
    if (sprintNumber && !Number.isInteger(sprintNumber)) fail("Sprint is not a number");

    var tasks = taskList.join('|')
    ensureBuildConfigGeneratorPrereqs(baseConfigToolPath);
    var programPath = `dotnet run --no-launch-profile --project "${baseConfigToolPath}/BuildConfigGen.csproj" -- `

    const args = [
        "--task",
        `"${tasks}"`
    ];

    if (sprintNumber) {
        args.push("--current-sprint");
        args.push(sprintNumber);
    }

    var writeUpdateArg = "";
    if(writeUpdates)
    {
        writeUpdateArg += " --write-updates";
    }

    if(includeLocalPackagesBuildConfig)
    {
        writeUpdateArg += " --include-local-packages-build-config";
    }

    var debugAgentDirArg = "";
    if(debugAgentDir) {
        debugAgentDirArg += ` --debug-agent-dir ${debugAgentDir}`;
    }

    banner(`Validating: tasks ${tasks} \n`);
    run(`${programPath} ${args.join(' ')} ${writeUpdateArg} ${debugAgentDirArg}`, true);

}
exports.processGeneratedTasks = processGeneratedTasks;

/**
 * Function to merge all tasks under a build config into base tasks.
 * @param {String} buildConfig that selected to merge
 */
var mergeBuildConfigIntoBaseTasks = function(buildConfig) {
    var makeOptionsPath = path.join(__dirname, 'make-options.json');
    var makeOptions = fileToJson(makeOptionsPath);
    if (!makeOptions) fail("makeOptions is not defined");
    const AllTasksToMerge = makeOptions[buildConfig];
    const TasksfailedToMerge = [];

    const match = buildConfig.match(/^([a-zA-Z]+[0-9]+)_\d+(_\d+)?$/);
    var surfixBuildConfig = match ? match[1] : buildConfig;

    if (AllTasksToMerge && Array.isArray(AllTasksToMerge)) {
        AllTasksToMerge.forEach(taskName => {
            var generatedTaskPath = path.join(__dirname, '_generated', `${taskName}_${surfixBuildConfig}`);
            var generatedDefaultTaskPath = path.join(__dirname, '_generated', taskName)
            var versionmapFilePath = path.join(__dirname, '_generated', `${taskName}.versionmap.txt`);
            var baseTaskPath = path.join(__dirname, 'Tasks', taskName);
            var buildConfigTaskPath = path.join(baseTaskPath, '_buildConfigs', surfixBuildConfig);

            if (!fs.existsSync(generatedTaskPath) || !fs.statSync(generatedTaskPath).isDirectory() || !fs.existsSync(versionmapFilePath)) {
                console.log(`Invalid generated task path ${generatedTaskPath} or invalid ${taskName}.versionmap.txt file ${versionmapFilePath}\n`);
                TasksfailedToMerge.push(taskName);
            } else {
                banner(`Merging ${generatedTaskPath} into base task...`);

                // Copy generated task to base task, delete generated files
                cp('-rf', generatedTaskPath + "/*", baseTaskPath);
                cp('-rf', generatedTaskPath + "/.npmrc", baseTaskPath);
                console.log(`Copied ${generatedTaskPath} to ${baseTaskPath}`);
                rm("-rf", buildConfigTaskPath);
                console.log(`Deleted ${buildConfigTaskPath} folder`);
                rm("-rf", generatedTaskPath);
                console.log(`Deleted ${generatedTaskPath} folder`);
                rm("-rf", generatedDefaultTaskPath);
                console.log(`Deleted ${generatedDefaultTaskPath} folder`);
                rm("-rf", versionmapFilePath);
                console.log(`Deleted ${versionmapFilePath} file`);

                // Remove _buildConfigMapping section in task.json and task-loc.json
                var taskJsonPath = path.join(baseTaskPath, 'task.json');
                var taskJson = JSON.parse(fs.readFileSync(taskJsonPath));
                var taskLocJsonPath = path.join(baseTaskPath, 'task.loc.json');
                var taskLocJson = JSON.parse(fs.readFileSync(taskLocJsonPath));
                if (taskJson && taskJson["_buildConfigMapping"]) {
                    delete taskJson["_buildConfigMapping"];
                }
                if (taskLocJson && taskLocJson["_buildConfigMapping"]) {
                    delete taskLocJson["_buildConfigMapping"];
                }
                fs.writeFileSync(taskJsonPath, JSON.stringify(taskJson, null, 2));
                fs.writeFileSync(taskLocJsonPath, JSON.stringify(taskLocJson, null, 2));
                console.log(`Updated task.json and task-loc.json files under ${baseTaskPath}`);
                console.log(`${generatedTaskPath} was merged into ${baseTaskPath}\n`);
            }
        });
    } else {
        fail(`Invalid configuration for ${buildConfig}.`);
    }

    // Update make-options.json
    if (TasksfailedToMerge.length > 0) {
        console.log('The following tasks failed to merge into base tasks: ' + TasksfailedToMerge);
        makeOptions[buildConfig] = makeOptions[buildConfig].filter(item =>
            TasksfailedToMerge.includes(item)
        );
    } else {
        delete makeOptions[buildConfig];
    }
    fs.writeFileSync(makeOptionsPath, JSON.stringify(makeOptions, null, 4));
    console.log("Updated make-options.json file");
}
exports.mergeBuildConfigIntoBaseTasks = mergeBuildConfigIntoBaseTasks;

/**
 * Wrapper for buildTask function which compares diff between source and generated tasks
 * @param {Function} originalFunction - Original buildTask function
 * @param {string} basicGenTaskPath - path to generated folder
 * @param {boolean} callGenTaskDuringBuild - if false, the sync step will be skipped
 * @returns {Function} - wrapped buildTask function which compares diff between source and generated tasks
 * and copy files from generated to source if needed
 */
function syncGeneratedFilesWrapper(originalFunction, basicGenTaskPath, basicGenTaskPathLocal, includeLocalPackagesBuildConfig, callGenTaskDuringBuild = false) {
    const runtimeChangedFiles = ["package.json", "package-lock.json", "npm-shrinkwrap.json"];

    if (!originalFunction || originalFunction instanceof Function === false) throw Error('originalFunction is not defined');
    // If the task is building on the ci, we don't want to sync files
    if (callGenTaskDuringBuild === false) return originalFunction;

    return async function(taskName, ...args) {
        await originalFunction.apply(this, [taskName, ...args]);

        var genTaskPath = path.join(basicGenTaskPath, taskName);

        if (includeLocalPackagesBuildConfig && !fs.existsSync(genTaskPath)) {
            genTaskPath = path.join(basicGenTaskPathLocal, taskName);
        };

        // if it's not a generated task, we don't need to sync files
        if (!fs.existsSync(genTaskPath)){
            return;
        }

        const [ baseTaskName, config ] = taskName.split("_");
        const copyCandidates = shell.find(genTaskPath)
            .filter(function (item) {
                // ignore node_modules
                if (item.indexOf("node_modules") !== -1) return false
                // ignore everything except package.json, package-lock.json, npm-shrinkwrap.json
                if (!runtimeChangedFiles.some((pattern) => item.indexOf(pattern) !== -1)) return false;

                return true;
            });

        copyCandidates.forEach((candidatePath) => {
            const relativePath = path.relative(genTaskPath, candidatePath);
            let dest = path.join(__dirname, 'Tasks', baseTaskName, relativePath);

            if (config) {
                if(config==="LocalPackages"){
                    dest = path.join(__dirname, '_generated', '_buildConfigs', baseTaskName, config, relativePath);
                }else{
                    dest = path.join(__dirname, 'Tasks', baseTaskName, '_buildConfigs', config, relativePath);
                }
            }

            // update Tasks/[task]/_buildConfigs/[configs]/package.json, etc if it already exists, unless it's package-lock.json/npm-shrinkwrap.json. (we need to update package-lock.json as the server build uses npm ci which requires package-lock.json to be in sync with package.json)
            const isPackageLock = path.basename(dest).toLowerCase() == "package-lock.json";
            const isNpmShrinkWrap = path.basename(dest).toLowerCase() == "npm-shrinkwrap.json";

            if(fs.existsSync(dest) || isPackageLock || isNpmShrinkWrap)
            {
                const folderPath = path.dirname(dest);
                if (!fs.existsSync(folderPath)) {
                    console.log(`Creating folder ${folderPath}`);
                    shell.mkdir('-p', folderPath);
                }

                console.log(`Copying ${candidatePath} to ${dest}`);
                fs.copyFileSync(candidatePath, dest);
            }
        });
    }
}

exports.syncGeneratedFilesWrapper = syncGeneratedFilesWrapper;

function getChangedTasks() {
    const changedTasks = [];
    const changedFiles = run('git diff --name-only origin/master', false, true).split('\n');

    changedFiles.forEach((file) => {
        if (file.startsWith('Tasks/')) {
            const taskName = file.split('/')[1];
            if (!changedTasks.includes(taskName)) {
                changedTasks.push(taskName);
            }
        }
    });
    return changedTasks;
}

exports.getChangedTasks = getChangedTasks;

async function getCurrentSprint() {
    const result = await fetch("https://whatsprintis.it", {
        headers: {
            "Accept": "application/json"
        }
    });

    return result.json();
}

exports.getCurrentSprint = getCurrentSprint;

//------------------------------------------------------------------------------
