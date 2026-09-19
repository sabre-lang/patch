#!/usr/bin/env pwsh

# check if we can actually output colors or not
$C_NONE = if ($env:NO_COLOR -or [System.Console]::IsOutputRedirected) { $true } else { $false }

$C_RESET = if ($C_NONE) { "" } else { [char]27 + "[0m"; };
$C_YELLOW = if ($C_NONE) { "" } else { [char]27 + "[1;33m"; };

# declare to the user what is actually going to occur
Write-Host "${C_YELLOW}Notice${C_RESET}: Forced upgrade to Sabre latest release";

# and re-call the upstream connection now
irm https://sabre.roessler.io/install.ps1 | iex
