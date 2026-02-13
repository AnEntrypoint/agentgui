#!/bin/bash
set -e

echo "=========================================="
echo "npm Granular Access Token Setup (3-Month)"
echo "=========================================="
echo ""
echo "STEP 1: Manual token generation on npm.org"
echo "=========================================="
echo ""
echo "Please follow these steps:"
echo ""
echo "1. Open your browser and go to:"
echo "   https://www.npmjs.com/settings/lanmower/tokens"
echo ""
echo "2. Click 'Generate New Token'"
echo ""
echo "3. Select 'Granular Access Token'"
echo ""
echo "4. Fill in the form:"
echo "   - Token name: github-actions-3month"
echo "   - Description: GitHub Actions npm publishing (3 month validity)"
echo "   - Permissions: Read and write"
echo "   - Packages: agentgui"
echo "   - Expiration: 90 days"
echo "   - Bypass 2FA: CHECKED"
echo ""
echo "5. Click 'Generate'"
echo ""
echo "6. COPY the token value (shown only once!)"
echo ""
echo "=========================================="
echo "STEP 2: Add token to GitHub Actions secret"
echo "=========================================="
echo ""
read -p "Paste your npm token here: " NPM_TOKEN

if [ -z "$NPM_TOKEN" ]; then
    echo "Error: Token cannot be empty"
    exit 1
fi

echo ""
echo "Setting GitHub Actions secret..."

gh secret set NPM_TOKEN --body "$NPM_TOKEN" --repo AnEntrypoint/agentgui

echo ""
echo "Verifying secret was set..."
gh secret list --repo AnEntrypoint/agentgui | grep NPM_TOKEN

echo ""
echo "=========================================="
echo "STEP 3: Test the workflow"
echo "=========================================="
echo ""
echo "Creating test commit to trigger workflow..."

git -C /home/user/agentgui commit --allow-empty -m "test: verify npm publishing with 3-month token"
git -C /home/user/agentgui push

echo ""
echo "Monitor the workflow at:"
echo "https://github.com/AnEntrypoint/agentgui/actions"
echo ""
echo "=========================================="
echo "Setup Complete!"
echo "=========================================="
