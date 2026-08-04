#!/bin/bash
# Bash script to convert MP4 videos to WebM format
# Requires ffmpeg to be installed
# Usage: ./convert-videos-to-webm.sh

echo "Converting MP4 videos to WebM format..."

# Check if ffmpeg is available
if ! command -v ffmpeg &> /dev/null; then
    echo "ERROR: ffmpeg is not installed or not in PATH."
    echo "Please install ffmpeg:"
    echo "  macOS: brew install ffmpeg"
    echo "  Ubuntu/Debian: sudo apt-get install ffmpeg"
    echo "  Windows: Download from https://ffmpeg.org/download.html"
    exit 1
fi

# Directories to process
IDLE_DIR="companions/idle"
SPEAKING_DIR="companions/speaking"

# Function to convert a single video
convert_video() {
    local input_path="$1"
    local output_path="$2"
    
    if [ ! -f "$input_path" ]; then
        echo "Skipping $input_path (file not found)"
        return 1
    fi
    
    if [ -f "$output_path" ]; then
        echo "Skipping $output_path (already exists)"
        return 0
    fi
    
    echo "Converting: $input_path -> $output_path"
    
    # FFmpeg command for WebM conversion (VP9 codec, good quality, small file size)
    ffmpeg -i "$input_path" \
        -c:v libvpx-vp9 \
        -crf 30 \
        -b:v 0 \
        -c:a libopus \
        -b:a 64k \
        -row-mt 1 \
        -threads 0 \
        -y \
        "$output_path" 2>&1 | grep -E "(error|Error|ERROR)" && return 1
    
    if [ $? -eq 0 ]; then
        echo "✓ Success: $output_path"
        
        # Show file size comparison
        input_size=$(du -h "$input_path" | cut -f1)
        output_size=$(du -h "$output_path" | cut -f1)
        echo "  Size: $input_size -> $output_size"
        return 0
    else
        echo "✗ Failed: $input_path"
        return 1
    fi
}

# Convert idle videos
echo ""
echo "=== Converting Idle Videos ==="
if [ -d "$IDLE_DIR" ]; then
    idle_count=0
    idle_success=0
    
    for file in "$IDLE_DIR"/*.mp4; do
        if [ -f "$file" ]; then
            idle_count=$((idle_count + 1))
            input_path="$file"
            output_path="${file%.mp4}.webm"
            
            if convert_video "$input_path" "$output_path"; then
                idle_success=$((idle_success + 1))
            fi
        fi
    done
    
    echo "Idle videos: $idle_success/$idle_count converted"
else
    echo "Directory not found: $IDLE_DIR"
fi

# Convert speaking videos
echo ""
echo "=== Converting Speaking Videos ==="
if [ -d "$SPEAKING_DIR" ]; then
    speaking_count=0
    speaking_success=0
    
    for file in "$SPEAKING_DIR"/*.mp4; do
        if [ -f "$file" ]; then
            speaking_count=$((speaking_count + 1))
            input_path="$file"
            output_path="${file%.mp4}.webm"
            
            if convert_video "$input_path" "$output_path"; then
                speaking_success=$((speaking_success + 1))
            fi
        fi
    done
    
    echo "Speaking videos: $speaking_success/$speaking_count converted"
else
    echo "Directory not found: $SPEAKING_DIR"
fi

echo ""
echo "=== Conversion Complete ==="
echo "WebM files are now available alongside MP4 files."
echo "The code will automatically use WebM when available, falling back to MP4."
