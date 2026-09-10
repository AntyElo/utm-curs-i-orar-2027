<#
.SYNOPSIS
    Register the MD Publisher as a Windows scheduled task.

.DESCRIPTION
    The logon model is an explicit, mandatory decision. There is no implicit fallback, and S4U
    is not offered at all:

      Interactive  the task runs only while the account is logged on. This is the recommended
                   model for the current laptop, which stays logged in.
      Password     the task stores the account password and can run before logon. Choose this
                   only when unattended pre-logon execution is actually required.

    An existing task registered with S4U is never overwritten silently: re-run with -Force after
    reading why it was registered that way.

.PARAMETER LogonMode
    Interactive or Password. Mandatory.

.PARAMETER User
    Account to run as. Required for -LogonMode Password; defaults to the current user otherwise.

.EXAMPLE
    .\install-task.ps1 -LogonMode Interactive

.EXAMPLE
    .\install-task.ps1 -LogonMode Password -User "LAPTOP\publisher"
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Interactive', 'Password')]
    [string] $LogonMode,

    [string] $User,

    [ValidateRange(5, 1440)]
    [int] $IntervalMinutes = 20,

    # Deliberately well below the cadence: a run that is still going when the next one is due has
    # hung, and Windows must reclaim it before the repetition fires. This is an operational
    # hygiene bound, not a correctness mechanism -- a killed run leaves the broker untouched, and
    # the next run resumes or re-derives everything it needs from the broker itself.
    [ValidateRange(1, 60)]
    [int] $ExecutionTimeLimitMinutes = 10,

    [string] $TaskName = 'FCIM MD Publisher',

    [string] $StateDir,

    [switch] $Force
)

$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$entryPoint = Join-Path $scriptRoot 'dist\tools\md-publisher\src\index.js'

if (-not (Test-Path $entryPoint)) {
    throw "Publisher build not found at $entryPoint. Run 'npm run build' in $scriptRoot first."
}

$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) {
    throw 'node was not found on PATH. Install Node.js 20 or newer before registering the task.'
}

if (-not $StateDir) {
    $StateDir = Join-Path $env:LOCALAPPDATA 'fcim-md-publisher'
}

if ($LogonMode -eq 'Password') {
    if (-not $User) {
        throw '-User is required with -LogonMode Password. There is no implicit account fallback.'
    }
} elseif (-not $User) {
    $User = "$env:USERDOMAIN\$env:USERNAME"
}

# Refuse to silently replace a task that someone deliberately registered with S4U.
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    $existingLogon = $existing.Principal.LogonType
    if ($existingLogon -eq 'S4U' -and -not $Force) {
        throw @"
Task '$TaskName' is already registered with LogonType S4U, which this deployment does not use.
Re-registering would silently change how the publisher runs.

Review why it was registered that way, then re-run this installer with -Force to replace it:
    .\install-task.ps1 -LogonMode $LogonMode -Force
"@
    }
    Write-Host "Replacing existing task '$TaskName' (LogonType $existingLogon)."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

New-Item -ItemType Directory -Path $StateDir -Force | Out-Null

# Record the logon model where the publisher can read it, so `doctor` and every heartbeat report
# how this machine is actually registered rather than what someone intended.
$configPath = Join-Path $StateDir 'config.json'
$config = @{}
if (Test-Path $configPath) {
    try {
        $existingConfig = Get-Content $configPath -Raw | ConvertFrom-Json
        foreach ($property in $existingConfig.PSObject.Properties) {
            $config[$property.Name] = $property.Value
        }
    } catch {
        Write-Warning "Existing $configPath could not be parsed; it will be replaced."
    }
}
$config['logon_model'] = $LogonMode
$config | ConvertTo-Json -Depth 5 | Set-Content -Path $configPath -Encoding utf8

$action = New-ScheduledTaskAction -Execute $node.Source -Argument "`"$entryPoint`" publish" -WorkingDirectory $scriptRoot

$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)

# Limited run level: the publisher downloads files and makes HTTPS requests. It never needs
# elevation, and a scheduled task that runs elevated is a much larger blast radius if abused.
if ($LogonMode -eq 'Interactive') {
    $principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
} else {
    $principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Password -RunLevel Limited
}

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes $ExecutionTimeLimitMinutes) `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 5)

$register = @{
    TaskName    = $TaskName
    Action      = $action
    Trigger     = $trigger
    Principal   = $principal
    Settings    = $settings
    Description = 'Transport-only FCIM timetable publisher. Uploads candidate bytes to the broker; makes no acceptance decisions.'
}

if ($LogonMode -eq 'Password') {
    Write-Host "Registering '$TaskName' for $User with a stored password."
    Write-Host 'You will be prompted for the account password by Windows.'
    $credential = Get-Credential -UserName $User -Message "Password for the '$TaskName' scheduled task"
    Register-ScheduledTask @register -User $User -Password $credential.GetNetworkCredential().Password | Out-Null
} else {
    Write-Host "Registering '$TaskName' for $User in Interactive mode."
    Write-Host 'The task runs only while this account is logged on.'
    Register-ScheduledTask @register | Out-Null
}

Write-Host ''
Write-Host "Registered '$TaskName' (LogonMode: $LogonMode, every $IntervalMinutes minutes, execution time limit $ExecutionTimeLimitMinutes minutes)."
Write-Host 'Set MD_PUBLISHER_BROKER_URL and MD_PUBLISHER_TOKEN for this account before the first run.'
Write-Host "Verify with:  node `"$entryPoint`" doctor"
