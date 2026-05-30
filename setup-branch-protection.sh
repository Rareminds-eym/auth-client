#!/bin/bash

# Branch Protection Setup Script
# Locks production, main, and dev branches
# Only allows merges by the repository owner

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
echo "  1. Lock 'production', 'main', and 'dev' branches"
echo "  2. Restrict merges to: $USERNAME only"
echo "  3. Require 1 PR approval"
echo "  4. Prevent force pushes and branch deletion"
echo "  5. Enforce rules for administrators too"
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
  
  REPO_SUCCESS=0
  
  for BRANCH in "${BRANCHES[@]}"; do
    # Check if branch exists
    if ! gh api repos/$ORG/$REPO/branches/$BRANCH &> /dev/null; then
      echo "  ⚠ '$BRANCH' branch not found - skipping"
      continue
    fi
    
    echo "  → Protecting '$BRANCH' branch..."
    
    # Configure branch protection
    gh api repos/$ORG/$REPO/branches/$BRANCH/protection \
      --input - << EOF > /dev/null 2>&1
{
  "required_status_checks": null,
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": false,
    "require_code_owner_reviews": false,
    "required_approving_review_count": 1,
    "require_last_push_approval": false
  },
  "restrictions": {
    "users": ["$USERNAME"],
    "teams": [],
    "apps": []
  },
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": false,
  "required_linear_history": false
}
EOF

    if [ $? -eq 0 ]; then
      echo "    ✓ '$BRANCH' protected successfully"
      ((REPO_SUCCESS++))
    else
      echo "    ✗ Failed to protect '$BRANCH'"
      ((FAILED++))
    fi
  done
  
  if [ $REPO_SUCCESS -eq 3 ]; then
    echo "  ✓ $REPO fully configured"
    ((SUCCESS++))
  else
    ((SKIPPED++))
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
echo "    - Requires 1 PR approval"
echo "    - Only $USERNAME can merge"
echo "    - No force pushes allowed"
echo "    - No branch deletion allowed"
echo "    - Rules enforced for administrators too"
echo ""
echo "To merge to these branches:"
echo "  1. Create a PR from another branch"
echo "  2. Get 1 approval"
echo "  3. $USERNAME must merge the PR"
echo ""
