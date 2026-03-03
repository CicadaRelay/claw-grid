#!/bin/bash
# MemoV .mem/ GC script
# Triggers when .mem/ > 1GB, keeps last 30 days of commits

MEM_DIR="${1:-.mem}"
MAX_SIZE_GB=1
KEEP_DAYS=30

echo "=== MemoV GC starting ==="
echo "Mem dir: $MEM_DIR"
echo "Max size: ${MAX_SIZE_GB}GB"
echo "Keep days: $KEEP_DAYS"

# Check if mem dir exists
if [ ! -d "$MEM_DIR" ]; then
  echo "Error: Mem dir $MEM_DIR not found"
  exit 1
fi

# Calculate current size
CURRENT_SIZE_GB=$(du -sm "$MEM_DIR" | awk '{print $1/1024}')
echo "Current size: ${CURRENT_SIZE_GB}GB"

# Check if GC needed
if (( $(echo "$CURRENT_SIZE_GB < $MAX_SIZE_GB" | bc -l) )); then
  echo "Size below threshold, no GC needed"
  exit 0
fi

echo "Size exceeds threshold, starting GC..."

# Git GC
cd "$MEM_DIR" || exit 1

# Expire old reflogs
git reflog expire --expire="${KEEP_DAYS} days" --all

# Prune loose objects
git gc --prune="${KEEP_DAYS} days" --aggressive

# Cleanup worktrees if any
git worktree prune

# Verify size after GC
NEW_SIZE_GB=$(du -sm "$MEM_DIR" | awk '{print $1/1024}')
echo "GC complete!"
echo "New size: ${NEW_SIZE_GB}GB"
echo "Freed: $(echo "$CURRENT_SIZE_GB - $NEW_SIZE_GB" | bc -l)GB"
