# PowerShell script to convert MP4 videos to WebM format
# Requires ffmpeg to be installed and in PATH
# Usage: .\convert-videos-to-webm.ps1

Write-Host "Converting MP4 videos to WebM format..." -ForegroundColor Green

# Check if ffmpeg is available
$ffmpegCheck = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ffmpegCheck) {
    Write-Host "ERROR: ffmpeg is not installed or not in PATH." -ForegroundColor Red
    Write-Host "Please install ffmpeg from https://ffmpeg.org/download.html" -ForegroundColor Yellow
    Write-Host "Or use: winget install ffmpeg" -ForegroundColor Yellow
    exit 1
}

# Directories to process
$idleDir = "companions\idle"
$speakingDir = "companions\speaking"

# Function to convert a single video
function Convert-Video {
    param(
        [string]$inputPath,
        [string]$outputPath
    )
    
    if (-not (Test-Path $inputPath)) {
        Write-Host "Skipping $inputPath (file not found)" -ForegroundColor Yellow
        return $false
    }
    
    if (Test-Path $outputPath) {
        Write-Host "Skipping $outputPath (already exists)" -ForegroundColor Yellow
        return $true
    }
    
    Write-Host "Converting: $inputPath -> $outputPath" -ForegroundColor Cyan
    
    # FFmpeg command for WebM conversion (VP9 codec, good quality, small file size)
    $ffmpegArgs = @(
        "-i", $inputPath,
        "-c:v", "libvpx-vp9",           # VP9 video codec (best compression)
        "-crf", "30",                    # Quality (18-63, lower = better quality, 30 is good balance)
        "-b:v", "0",                     # Variable bitrate
        "-c:a", "libopus",               # Opus audio codec
        "-b:a", "64k",                   # Audio bitrate (64k is good for speech)
        "-row-mt", "1",                  # Multi-threading
        "-threads", "0",                 # Use all available threads
        "-y",                            # Overwrite output file
        $outputPath
    )
    
    $process = Start-Process -FilePath "ffmpeg" -ArgumentList $ffmpegArgs -NoNewWindow -Wait -PassThru
    
    if ($process.ExitCode -eq 0) {
        Write-Host "✓ Success: $outputPath" -ForegroundColor Green
        
        # Show file size comparison
        $inputSize = (Get-Item $inputPath).Length / 1MB
        $outputSize = (Get-Item $outputPath).Length / 1MB
        $savings = (($inputSize - $outputSize) / $inputSize) * 100
        Write-Host "  Size: $([math]::Round($inputSize, 2))MB -> $([math]::Round($outputSize, 2))MB (saved $([math]::Round($savings, 1))%)" -ForegroundColor Gray
        return $true
    } else {
        Write-Host "✗ Failed: $inputPath" -ForegroundColor Red
        return $false
    }
}

# Convert idle videos
Write-Host "`n=== Converting Idle Videos ===" -ForegroundColor Cyan
if (Test-Path $idleDir) {
    $idleFiles = Get-ChildItem -Path $idleDir -Filter "*.mp4"
    $idleCount = 0
    $idleSuccess = 0
    
    foreach ($file in $idleFiles) {
        $idleCount++
        $inputPath = $file.FullName
        $outputPath = $inputPath -replace '\.mp4$', '.webm'
        
        if (Convert-Video -inputPath $inputPath -outputPath $outputPath) {
            $idleSuccess++
        }
    }
    
    Write-Host "Idle videos: $idleSuccess/$idleCount converted" -ForegroundColor $(if ($idleSuccess -eq $idleCount) { "Green" } else { "Yellow" })
} else {
    Write-Host "Directory not found: $idleDir" -ForegroundColor Yellow
}

# Convert speaking videos
Write-Host "`n=== Converting Speaking Videos ===" -ForegroundColor Cyan
if (Test-Path $speakingDir) {
    $speakingFiles = Get-ChildItem -Path $speakingDir -Filter "*.mp4"
    $speakingCount = 0
    $speakingSuccess = 0
    
    foreach ($file in $speakingFiles) {
        $speakingCount++
        $inputPath = $file.FullName
        $outputPath = $inputPath -replace '\.mp4$', '.webm'
        
        if (Convert-Video -inputPath $inputPath -outputPath $outputPath) {
            $speakingSuccess++
        }
    }
    
    Write-Host "Speaking videos: $speakingSuccess/$speakingCount converted" -ForegroundColor $(if ($speakingSuccess -eq $speakingCount) { "Green" } else { "Yellow" })
} else {
    Write-Host "Directory not found: $speakingDir" -ForegroundColor Yellow
}

Write-Host "`n=== Conversion Complete ===" -ForegroundColor Green
Write-Host "WebM files are now available alongside MP4 files." -ForegroundColor Gray
Write-Host "The code will automatically use WebM when available, falling back to MP4." -ForegroundColor Gray
