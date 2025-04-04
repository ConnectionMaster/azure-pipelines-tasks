[CmdletBinding()]
param
(
    [String] [Parameter(Mandatory = $true)]
    $endpoint,
    [String] [Parameter(Mandatory = $false)]
    $targetAzurePs,
    [String] [Parameter(Mandatory = $false)]
    $clientAssertionJwt,
    [String] [Parameter(Mandatory = $false)]
    $serviceConnectionId
)

$endpointObject =  ConvertFrom-Json  $endpoint
$moduleName = "Az.Accounts"
$environmentName = $endpointObject.environment

. "$PSScriptRoot/Utility.ps1"
Update-PSModulePathForHostedAgentLinux -targetAzurePs $targetAzurePs

if ($targetAzurePs -eq "") {
    $module = Get-Module -Name $moduleName -ListAvailable | Sort-Object Version -Descending | Select-Object -First 1
}
else{
    $modules = Get-Module -Name $moduleName -ListAvailable
    foreach ($moduleVal in $modules) {
        # $moduleVal.Path will have value like /usr/local/share/powershell/Modules/Az.Accounts/1.2.1/Az.Accounts.psd1
        $azModulePath = Split-Path (Split-Path (Split-Path $moduleVal.Path -Parent) -Parent) -Parent
        $azModulePath = $azModulePath + "/Az/*"
        $azModuleVersion = split-path -path $azModulePath -Leaf -Resolve
        if ($azModuleVersion -eq $targetAzurePs) {
            $module = $moduleVal
            break
        }
    }
}

if (!$module) {
    # Will handle localization later
    Write-Verbose "No module found with name: $moduleName"
    throw ("Could not find the module Az.Accounts with given version. If the module was recently installed, retry after restarting the Azure Pipelines task agent.")
}

# Import the module.
Write-Host "##[command]Import-Module -Name $($module.Path) -Global"
$module = Import-Module -Name $module.Path -Global -PassThru -Force

# Clear context
Write-Host "##[command]Clear-AzContext -Scope Process"
$null = Clear-AzContext -Scope Process
Write-Host "##[command]Clear-AzContext -Scope CurrentUser -Force -ErrorAction SilentlyContinue"
$null = Clear-AzContext -Scope CurrentUser -Force -ErrorAction SilentlyContinue

$scopeLevel = "Subscription"
if ($endpointObject.scopeLevel) {
    $scopeLevel = $endpointObject.scopeLevel
}
$processScope = @{ Scope = "Process" }

function Format-Splat {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][hashtable]$Hashtable)

    # Collect the parameters (names and values) in an array.
    $parameters = foreach ($key in $Hashtable.Keys) {
        $value = $Hashtable[$key]
        # If the value is a bool, format the parameter as a switch (ending with ':').
        if ($value -is [bool]) { "-$($key):" } else { "-$key" }
        $value
    }

    "$parameters" # String join the array.
}

if ($endpointObject.scheme -eq 'ServicePrincipal') {
    Write-Verbose "Using ServicePrincipal authentication scheme"
    try {
        if ($endpointObject.authenticationType -ieq 'SPNKey') {
            $psCredential = New-Object System.Management.Automation.PSCredential(
                    $endpointObject.servicePrincipalClientID,
                    (ConvertTo-SecureString $endpointObject.servicePrincipalKey -AsPlainText -Force))
            Write-Host "##[command]Connect-AzAccount -ServicePrincipal -Tenant $($endpointObject.tenantId) -Credential $psCredential -Environment $environmentName @processScope"
            $null = Connect-AzAccount -ServicePrincipal -Tenant $endpointObject.tenantId `
            -Credential $psCredential `
            -Environment $environmentName @processScope -WarningAction SilentlyContinue
        }
        else {
            # Provide an additional, custom, credentials-related error message. Will handle localization later
            throw ("Only SPNKey auth type is supported for ServicePrincipal auth scheme using non windows agent.")
        }
    }
    catch {
        # Provide an additional, custom, credentials-related error message. Will handle localization later
        Write-Host "Exception is : $($_.Exception.Message)"
        throw (New-Object System.Exception("There was an error with the service principal used for the deployment.", $_.Exception))
    }

    if ($scopeLevel -eq "Subscription") {
        $SubscriptionId = $endpointObject.subscriptionId
        $TenantId = $endpointObject.tenantId
        $additional = @{ TenantId = $TenantId }

        Write-Host "##[command] Set-AzContext -SubscriptionId $SubscriptionId $(Format-Splat $additional)"
        $null = Set-AzContext -SubscriptionId $SubscriptionId @additional
    }
}
elseif ($endpointObject.scheme -eq 'WorkloadIdentityFederation') {
    Write-Verbose "Using WorkloadIdentityFederation authentication scheme"

    $logStr = "##[command] Connect-AzAccount -ServicePrincipal -Tenant $($endpointObject.tenantId) -ApplicationId $($endpointObject.servicePrincipalClientID)"
    $logStr += " -FederatedToken ***** -Environment $environmentName -Scope Process"
    Write-Host $logStr
    $null = Connect-AzAccount -ServicePrincipal -Tenant $endpointObject.tenantId -ApplicationId $endpointObject.servicePrincipalClientID `
        -FederatedToken $clientAssertionJwt -Environment $environmentName -Scope 'Process'

    if ($scopeLevel -ne "ManagementGroup") {
        Write-Host "##[command] Set-AzContext -SubscriptionId $($endpointObject.subscriptionID) -TenantId $($endpointObject.tenantId)"
        $null = Set-AzContext -SubscriptionId $endpointObject.subscriptionID -TenantId $endpointObject.tenantId
    }

    $env:AZURESUBSCRIPTION_SERVICE_CONNECTION_ID = $serviceConnectionId
    $env:AZURESUBSCRIPTION_CLIENT_ID = $endpointObject.servicePrincipalClientID
    $env:AZURESUBSCRIPTION_TENANT_ID = $endpointObject.tenantId

    if (![System.Convert]::ToBoolean($env:DISABLE_INSTALL_MODULE_FIX)) {
        # This is a workaround for the issue where Clear-AzContext removes Install-Module command from the session 
        $null = Get-Command "Install-Module" -ErrorAction SilentlyContinue
    }    
}
else {
    #  Provide an additional, custom, credentials-related error message. Will handle localization later
    throw ("Only SPN credential and WorkloadIdentityFederation auth schemes are supported for non windows agent.")
}