param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectId,

  [Parameter(Mandatory = $true)]
  [string]$Region,

  [string]$AddressName = "ivucx-helper-ip",
  [string]$NetworkTier = "PREMIUM"
)

$ErrorActionPreference = "Stop"

gcloud compute addresses create $AddressName `
  --project=$ProjectId `
  --region=$Region `
  --network-tier=$NetworkTier
