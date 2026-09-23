<#
.SYNOPSIS
    Fetches and records the free Windows 11 Enterprise Evaluation ISO that
    New-CleanWindowsAcceptanceVm.ps1 installs the clean acceptance guest from.

.DESCRIPTION
    New-CleanWindowsAcceptanceVm.ps1 refuses to build the VM without -IsoPath
    and -IsoSha256, by design: unverified media makes the #106/#111 evidence
    unverifiable. Producing those two values by hand -- click through the
    Evaluation Center, save a file somewhere, run Get-FileHash -- is exactly
    the kind of step that is done differently on the next attempt, and there is
    then no record of which bytes the evidence was built from.

    This script is that step, made reproducible. It resolves Microsoft's own
    published link, downloads the ISO into a cache, measures it, and writes a
    provenance sidecar next to it naming every hop it followed.

    Everything about the media is free and unauthenticated:

      * the ISO is the Windows 11 Enterprise *Evaluation* image -- no licence
        key, no subscription, 90-day evaluation, offered for exactly this kind
        of testing;
      * the only entry point is the Evaluation Center's own fwlink id, so the
        URL is not a third-party mirror and not a link scraped once and pasted
        into a script where it would rot silently;
      * no account, cookie or form submission is involved. The fwlink chain
        resolves to an anonymous HTTPS download. If Microsoft ever puts this
        media behind registration, the script fails at that hop and says so
        rather than fetching something else.

    Integrity is handled the way the Android SDK pin (androidSdkPin.ts) handles
    it, and for the same reason: upstream publishes no digest for this file at
    all. So the digest is *measured* here and recorded, and -ExpectedSha256
    re-verifies a cached or re-fetched copy against a value a previous run
    recorded.

    Microsoft rotates this media on every servicing refresh, and the URL is not
    build-stable. That is why nothing is hard-coded here beyond the fwlink id: a
    rotation must show up as a new recorded digest in the acceptance evidence,
    never as a silent substitution under a fixed one.

.PARAMETER Destination
    Directory the ISO and its sidecar are cached in. Defaults to a per-user
    cache, deliberately outside the repository: the ISO is ~6.6 GB.

.PARAMETER LinkId
    Evaluation Center fwlink id. The default is the en-US 64-bit Windows 11
    Enterprise evaluation ISO as published on
    https://www.microsoft.com/en-us/evalcenter/download-windows-11-enterprise.

.PARAMETER ExpectedSha256
    Verify the ISO against this digest instead of only recording what was
    measured. This is how a second machine confirms it has the same bytes the
    evidence names.

.PARAMETER Force
    Re-download even when a full-length cached copy is already present.

.EXAMPLE
    .\Get-Windows11EvaluationIso.ps1

.EXAMPLE
    # Confirm a cached copy is the media the evidence was produced from.
    .\Get-Windows11EvaluationIso.ps1 -ExpectedSha256 <digest>
#>
[CmdletBinding()]
param(
    [string] $Destination = (Join-Path $env:LOCALAPPDATA 'DevHotel\acceptance-media'),
    [int]    $LinkId = 2334167,
    [string] $ExpectedSha256,
    [switch] $Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# The ISO is large enough that the progress bar costs real throughput.
$ProgressPreference = 'SilentlyContinue'

function Resolve-IsoUrl {
    <#
      Walks the fwlink redirect chain by hand instead of letting the HTTP stack
      follow it, so every hop lands in the provenance record. An acceptance
      artifact whose origin is "some redirect resolved to this" is not evidence.

      HttpClient rather than Invoke-WebRequest: PowerShell 7 treats
      -MaximumRedirection 0 as "redirect limit exceeded" and throws, so a 3xx
      response and its Location header are unreachable through that cmdlet --
      including with -SkipHttpErrorCheck, which only suppresses 4xx/5xx.
    #>
    param([Parameter(Mandatory)] [string] $StartUrl)

    $handler = [System.Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $client = [System.Net.Http.HttpClient]::new($handler)
    try {
        $client.Timeout = [TimeSpan]::FromMinutes(2)
        $chain = @($StartUrl)
        $url = $StartUrl
        for ($hop = 0; $hop -lt 10; $hop++) {
            $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Head, $url)
            $response = $client.SendAsync($request).GetAwaiter().GetResult()
            try {
                $status = [int] $response.StatusCode
                if ($status -ge 200 -and $status -lt 300) {
                    $length = if ($response.Content.Headers.ContentLength) { [int64] $response.Content.Headers.ContentLength } else { [int64] 0 }
                    return [pscustomobject]@{
                        Url           = $url
                        RedirectChain = $chain
                        ContentLength = $length
                    }
                }
                if ($status -lt 300 -or $status -ge 400) {
                    throw "Resolving the evaluation ISO stopped at HTTP $status for $url. Microsoft may have moved this media behind registration; resolve it by hand and pass the result to New-CleanWindowsAcceptanceVm.ps1 directly."
                }
                $next = $response.Headers.Location
                if (-not $next) { throw "HTTP $status with no Location header at $url." }
                $url = [uri]::new([uri] $url, $next).AbsoluteUri
                $chain += $url
            } finally {
                $response.Dispose()
            }
        }
        throw 'The evaluation ISO link redirected more than 10 times; refusing to follow further.'
    } finally {
        $client.Dispose()
        $handler.Dispose()
    }
}

function Assert-OfficialOrigin {
    <#
      The media must come from Microsoft. A redirect chain that ends anywhere
      else is a substitution, not a mirror, and the fetch must stop.
    #>
    param([Parameter(Mandatory)] [string] $Url)

    $uri = [uri] $Url
    if ($uri.Scheme -ne 'https') { throw "The evaluation ISO must be fetched over HTTPS; got $($uri.Scheme)." }
    $allowed = @(
        'software-static.download.prss.microsoft.com',
        'software.download.prss.microsoft.com',
        'download.microsoft.com'
    )
    if ($allowed -notcontains $uri.Host) {
        throw "The evaluation ISO resolved to $($uri.Host), which is not a Microsoft download origin. Refusing to cache it."
    }
}

if (-not (Test-Path -LiteralPath $Destination)) {
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
}

$startUrl = "https://go.microsoft.com/fwlink/?linkid=$LinkId&clcid=0x409&culture=en-us&country=us"
Write-Host "[iso] resolving Evaluation Center link $LinkId ..."
$resolved = Resolve-IsoUrl -StartUrl $startUrl
Assert-OfficialOrigin -Url $resolved.Url

# The filename Microsoft serves carries the build and the edition
# (...CLIENTENTERPRISEEVAL_OEMRET_x64FRE_en-us.iso), so it is kept rather than
# renamed: a cache holding two builds must not look like one file.
$fileName = [System.IO.Path]::GetFileName(([uri] $resolved.Url).LocalPath)
if (-not $fileName.EndsWith('.iso')) { throw "Resolved URL does not name an ISO: $($resolved.Url)" }
if ($fileName -notmatch 'ENTERPRISEEVAL') {
    throw "Resolved media '$fileName' is not an Enterprise Evaluation image. Refusing: this script only fetches media that is free to use for acceptance testing."
}

$isoPath = Join-Path $Destination $fileName
$sidecarPath = "$isoPath.provenance.json"

foreach ($hop in $resolved.RedirectChain) { Write-Host "[iso]   -> $hop" }
Write-Host "[iso] media : $fileName"
Write-Host "[iso] size  : $([math]::Round($resolved.ContentLength / 1GB, 2)) GB"
Write-Host "[iso] cache : $isoPath"

$needsDownload = $true
if ((Test-Path -LiteralPath $isoPath) -and -not $Force) {
    $have = (Get-Item -LiteralPath $isoPath).Length
    if ($resolved.ContentLength -gt 0 -and $have -eq $resolved.ContentLength) {
        Write-Host '[iso] cached copy is already the full length; not re-downloading (use -Force to override).'
        $needsDownload = $false
    } else {
        Write-Host "[iso] cached copy is $have bytes, expected $($resolved.ContentLength); re-downloading."
    }
}

if ($needsDownload) {
    # Downloaded under a temp name and moved into place only once complete, so
    # an interrupted run can never leave a truncated ISO that looks cached.
    $partial = "$isoPath.partial"
    if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
    Write-Host '[iso] downloading ...'
    $started = Get-Date
    Invoke-WebRequest -Uri $resolved.Url -OutFile $partial -ErrorAction Stop
    $elapsed = (Get-Date) - $started
    $got = (Get-Item -LiteralPath $partial).Length
    if ($resolved.ContentLength -gt 0 -and $got -ne $resolved.ContentLength) {
        Remove-Item -LiteralPath $partial -Force
        throw "Short download: got $got bytes, expected $($resolved.ContentLength)."
    }
    Move-Item -LiteralPath $partial -Destination $isoPath -Force
    Write-Host "[iso] downloaded $([math]::Round($got / 1GB, 2)) GB in $([math]::Round($elapsed.TotalMinutes, 1)) min"
}

Write-Host '[iso] measuring digests (this reads the whole file twice) ...'
$sha256 = (Get-FileHash -LiteralPath $isoPath -Algorithm SHA256).Hash.ToLowerInvariant()
$sha512 = (Get-FileHash -LiteralPath $isoPath -Algorithm SHA512).Hash.ToLowerInvariant()
$length = (Get-Item -LiteralPath $isoPath).Length

if ($ExpectedSha256) {
    if ($sha256 -ne $ExpectedSha256.ToLowerInvariant()) {
        throw "ISO digest mismatch. Expected $($ExpectedSha256.ToLowerInvariant()), measured $sha256. Microsoft rotates this media; if the rotation is expected, record the new digest in the acceptance evidence rather than relaxing this check."
    }
    Write-Host '[iso] digest matches -ExpectedSha256.'
}

$provenance = [ordered]@{
    fileName      = $fileName
    sizeBytes     = $length
    sha256        = $sha256
    sha512        = $sha512
    fwlinkId      = $LinkId
    redirectChain = $resolved.RedirectChain
    measuredUtc   = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    note          = 'Windows 11 Enterprise Evaluation -- free, no licence key, 90-day evaluation. Microsoft publishes no digest for this file, so the digest above was measured here.'
}
# ASCII, no BOM: the sidecar is read back by tooling, and a UTF-8 BOM from
# Windows PowerShell breaks a plain JSON parse.
$json = $provenance | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($sidecarPath, $json, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ''
Write-Host "[iso] sha256    : $sha256"
Write-Host "[iso] sha512    : $sha512"
Write-Host "[iso] provenance: $sidecarPath"
Write-Host ''
Write-Host 'Next:'
Write-Host "  .\New-CleanWindowsAcceptanceVm.ps1 -IsoPath '$isoPath' -IsoSha256 $sha256"

[pscustomobject]$provenance
