"use strict";

import * as fs from "fs";
import * as path from "path";
import * as tl from "azure-pipelines-task-lib/task";
import * as tr from "azure-pipelines-task-lib/toolrunner";
import * as utils from "./utils/utilities";
import * as toolLib from 'azure-pipelines-tool-lib/tool';

import { Kubelogin } from 'azure-pipelines-tasks-kubernetes-common/kubelogin';

export default class ClusterConnection {
    private kubectlPath: string;
    private kubeconfigFile: string;
    private userDir: string;

    constructor(existingKubeConfigPath?: string) {
        this.kubectlPath = tl.which("kubectl", false);
        this.userDir = utils.getNewUserDirPath();
        if (existingKubeConfigPath) {
            this.kubeconfigFile = existingKubeConfigPath;
        }
    }

    private loadClusterType(connectionType: string): any {
        if(connectionType === "azureResourceManager") {
            return require("azure-pipelines-tasks-azure-arm-rest/aksUtility")
        }
        else {
            return require("./clusters/generickubernetescluster");
        }
    }
    
    // get kubeconfig file path
    private async getKubeConfig(connectionType): Promise<string> {
        if (connectionType === "azureResourceManager") {
            const clusterName : string = tl.getInput("kubernetesCluster", true);
            const azureSubscriptionEndpoint : string = tl.getInput("azureSubscriptionEndpoint", true);
            const resourceGroup : string = tl.getInput("azureResourceGroup", true);
            const useClusterAdmin: boolean = tl.getBoolInput('useClusterAdmin');
            const resourceType: string = (tl.getInput("resourceType", false) || "Microsoft.ContainerService/managedClusters");
            if (resourceType.toLowerCase() == "microsoft.containerservice/fleets"){
                return this.loadClusterType(connectionType).getKubeConfigForFleet(azureSubscriptionEndpoint, resourceGroup, clusterName)
            }
            return this.loadClusterType(connectionType).getKubeConfig(azureSubscriptionEndpoint, resourceGroup, clusterName, useClusterAdmin)
        } else {
            return this.loadClusterType(connectionType).getKubeConfig()
        }
    }

    private async initialize(): Promise<void> {
        // prepend the tools path. instructs the agent to prepend for future tasks
        if(!process.env['PATH'].toLowerCase().startsWith(path.dirname(this.kubectlPath.toLowerCase()))) {
            toolLib.prependPath(path.dirname(this.kubectlPath));
        }
    }

    public createCommand(): tr.ToolRunner {
        var command = tl.tool(this.kubectlPath);
        return command;
    }

    // open kubernetes connection
    public async open() {
        var connectionType = tl.getInput("connectionType", true);
        console.log("Connection type: " + connectionType);
        if (connectionType === "None") {
            return this.initialize();
        }
        var kubeconfig;
        if (!this.kubeconfigFile) {
            kubeconfig = await this.getKubeConfig(connectionType);
        }

        return await this.initialize().then(async () => {
          if (kubeconfig) {
            this.kubeconfigFile = path.join(this.userDir, 'config');
            fs.writeFileSync(this.kubeconfigFile, kubeconfig);
          }

          process.env['KUBECONFIG'] = this.kubeconfigFile;

          const kubelogin = new Kubelogin(this.userDir);
          if (kubelogin.isAvailable()) {
            tl.debug('Kubelogin is installed. Converting kubeconfig.');
            const serviceConnection: string = tl.getInput('azureSubscriptionEndpoint', false);
            try {
                await kubelogin.login(serviceConnection);
            } catch (err) {
                tl.debug(tl.loc('KubeloginFailed', err));
            }
        }
        });
    }

    // close kubernetes connection
    public close(): void {
        var connectionType = tl.getInput("connectionType", true);
        if (connectionType === "None") {
            return;
        }
        if (this.kubeconfigFile != null && fs.existsSync(this.kubeconfigFile))
        {
           delete process.env["KUBECONFIG"];
           fs.unlinkSync(this.kubeconfigFile);
        }    
    }

    public setKubeConfigEnvVariable() {
        if (this.kubeconfigFile && fs.existsSync(this.kubeconfigFile)) {
            tl.setVariable("KUBECONFIG", this.kubeconfigFile);
        }
        else {
            tl.error(tl.loc('KubernetesServiceConnectionNotFound'));
            throw new Error(tl.loc('KubernetesServiceConnectionNotFound'));
        }
    }
    
    public unsetKubeConfigEnvVariable() {
        var kubeConfigPath = tl.getVariable("KUBECONFIG");
        if (kubeConfigPath) {
            tl.setVariable("KUBECONFIG", "");
        }
    }

    //excute kubernetes command
    public execCommand(command: tr.ToolRunner, options?: tr.IExecOptions) {
        var errlines = [];
        command.on("errline", line => {
            errlines.push(line);
        });

        tl.debug(tl.loc('CallToolRunnerExec'));
        
        let promise = command.exec(options)
        .fail(error => {
            tl.debug(tl.loc('ToolRunnerExecCallFailed', error));
            errlines.forEach(line => tl.error(line));
            throw error;
        })
        .then(() => {
            tl.debug(tl.loc('ToolRunnerExecCallSucceeded'));
        });

        tl.debug(tl.loc('ReturningToolRunnerExecPromise'));
        return promise;
    }
}
