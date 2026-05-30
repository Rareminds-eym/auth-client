#!/bin/bash

# Branch Protection Setup Script with Diagnostics
# Creates production, main, and dev branches (if they don't exist)
# Locks them and only allows merges by the repository owner

REPOS=(
  "auth-client"
  "auth-core"
  "code-reviewer"
  "csevbm-game"
  "daksyam"
  "educator-webinar-landing-page"
  "email-worker"
  "embedding-worker"
  "fapp-game"
  "FSQM"
  "fsqm-demo-ai"
  "game-dashboard"
  "gitex-dashboard"
  "GMP"
  "gmp-demo-ai"
  "GMQuest"
  "Greenminds"
  "Hackathon-Dashboard"
  "hackathon-data"
  "lms"
  "mc-demo-ai"
  "mc_hackathon"
  "Medical-Coding"
  "OFP"
  "OFP-Game"
  "payments-worker"
  "Quiz"
  "Rareminds-Dashboard"
  "rareminds-server"
  "Rareminds-Website"
  "Rareminds-Website-Backend"
  "Rareminds_New"
  "RarePrep"
  "react-web-app-template"
  "RM--Assessment"
  "RM-Labs"
  "rm-lms"
  "sgcev-game"
  "skillpassport"
  "sp-dash-2"
  "sso-worker"
)

BRANCHES=("production" "main" "dev")
ORG="Rareminds-eym"
USERNAME="gokulrajr-r"

echo "================================================"
echo "Branch Protection Setup for Rareminds-eym"
echo "================================================"
echo ""
echo "Configuration:"
echo "  Organization: $ORG"
echo "  Username: $USERNAME"
echo "  Total repos: ${#REPOS[@]}"
echo "  Branches to protect: ${BRANCHES[@]}"
echo ""
echo "This will:"
echo "  1. Create 'production', 'main', and 'dev' branches (if missing)"
echo "  2. Lock these branches - only merges allowed"
echo "  3. Restrict merges to: $USERNAME only"
echo "  4. Require 1 PR approval"
echo "  5. Prevent branch deletion"
echo "  6. Enforce rules for administrators too"
echo ""
read -p "Continue? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Cancelled."
  exit 1
fi

echo ""
echo "Starting configuration..."
echo ""

SUCCESS=0
FAILED=0
SKIPPED=0

for REPO in "${REPOS[@]}"; do
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "Repository: $ORG/$REPO"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  
  # Get the default branch
  DEFAULT_BRANCH=$(gh api repos/$ORG/$REPO --jq '.default_branch' 2>/dev/null)
  if [ -z "$DEFAULT_BRANCH" ]; then
    echo "  ✗ Failed to fetch repository info"
    ((FAILED++))
    continue
  fi
  
  echo "  Default branch: $DEFAULT_BRANCH"
  
  REPO_SUCCESS=0
  
  for BRANCH in "${BRANCHES[@]}"; do
    echo ""
    echo "  ─ Processing '$BRANCH' branch..."
    
    # Check if branch exists
    if gh api repos/$ORG/$REPO/branches/$BRANCH &> /dev/null; then
      echo "    ✓ '$BRANCH' branch already exists"
    else
      echo "    → Creating '$BRANCH' branch from '$DEFAULT_BRANCH'..."
      
      # Get the SHA of the default branch
      DEFAULT_SHA=$(gh api repos/$ORG/$REPO/git/refs/heads/$DEFAULT_BRANCH --jq '.object.sha' 2>/dev/null)
      
      if [ -z "$DEFAULT_SHA" ]; then
        echo "    ✗ Failed to get default branch SHA"
        continue
      fi
      
      # Create the new branch
      if gh api repos/$ORG/$REPO/git/refs \
        --input - << EOF > /dev/null 2>&1
{
  "ref": "refs/heads/$BRANCH",
  "sha": "$DEFAULT_SHA"
}
EOF
      then
        echo "    ✓ '$BRANCH' branch created successfully"
      else
        echo "    ✗ Failed to create '$BRANCH' branch"
        continue
      fi
    fi
    
    echo "    → Applying protection rules to '$BRANCH'..."
    
    # Create a temporary file for the JSON payload
    TEMP_FILE=$(mktemp)
    cat > "$TEMP_FILE" << 'EOF'
{
  "required_status_checks": null,
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": false,
    "require_code_owner_reviews": false,
    "required_approving_review_count": 1
  },
  "restrictions": {
    "users": ["USERNAME_PLACEHOLDER"],
    "teams": [],
    "apps": []
  },
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": false
}
EOF
    
    # Replace placeholder with actual username
    sed -i "s/USERNAME_PLACEHOLDER/$USERNAME/g" "$TEMP_FILE"
    
    # Try to apply protection
    RESPONSE=$(gh api repos/$ORG/$REPO/branches/$BRANCH/protection \
      --input "$TEMP_FILE" 2>&1)
    
    RESPONSE_CODE=$?
    
    if [ $RESPONSE_CODE -eq 0 ]; then
      echo "    ✓ Protection rules applied to '$BRANCH'"
      ((REPO_SUCCESS++))
    else
      echo "    ✗ Failed to apply protection rules to '$BRANCH'"
      echo "      Error: $(echo "$RESPONSE" | head -1)"
    fi
    
    rm -f "$TEMP_FILE"
  done
  
  echo ""
  if [ $REPO_SUCCESS -eq 3 ]; then
    echo "  ✓✓✓ $REPO fully configured"
    ((SUCCESS++))
  elif [ $REPO_SUCCESS -gt 0 ]; then
    echo "  ⚠⚠⚠ $REPO partially configured ($REPO_SUCCESS/3 branches)"
    ((SKIPPED++))
  else
    echo "  ✗✗✗ $REPO configuration failed"
    ((FAILED++))
  fi
  
  echo ""
done

echo "================================================"
echo "Configuration Complete!"
echo "================================================"
echo "Summary:"
echo "  ✓ Repositories fully configured: $SUCCESS"
echo "  ⚠ Partially configured/Skipped: $SKIPPED"
echo "  ✗ Failed: $FAILED"
echo ""
echo "Protected Branches Configuration:"
echo "  • production, main, dev"
echo "    - Created from default branch if missing"
echo "    - Requires 1 PR approval"
echo "    - Only $USERNAME can push/merge"
echo "    - No branch deletion allowed"
echo "    - Rules enforced for administrators too"
echo ""
