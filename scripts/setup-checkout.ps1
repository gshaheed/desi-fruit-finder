# One-time checkout setup for Desi Fruit Finder
# Run from repo root:  pwsh -File scripts/setup-checkout.ps1

$ErrorActionPreference = "Stop"
$WorkerUrl = "https://desi-fruit-check-stock.gurneetsshaheed.workers.dev"
$Repo = "gshaheed/desi-fruit-finder"

Write-Host "`n=== Desi Fruit Finder — Checkout Setup ===`n" -ForegroundColor Cyan

Write-Host "Step 1: Cloudflare API token"
Write-Host "  Open: https://dash.cloudflare.com/profile/api-tokens"
Write-Host "  Create token with 'Edit Cloudflare Workers' template`n"
$cfToken = Read-Host "Paste CLOUDFLARE_API_TOKEN (or Enter to skip)"
$cfAccount = Read-Host "Paste CLOUDFLARE_ACCOUNT_ID (or Enter to skip)"

Write-Host "`nStep 2: Stripe test keys"
Write-Host "  Open: https://dashboard.stripe.com/test/apikeys`n"
$stripeSk = Read-Host "Paste STRIPE_SECRET_KEY sk_test_... (or Enter to skip)"
$stripeWh = Read-Host "Paste STRIPE_WEBHOOK_SECRET whsec_... (or Enter to skip)"

if ($cfToken) { gh secret set CLOUDFLARE_API_TOKEN -R $Repo -b $cfToken }
if ($cfAccount) { gh secret set CLOUDFLARE_ACCOUNT_ID -R $Repo -b $cfAccount }
if ($stripeSk) { gh secret set STRIPE_SECRET_KEY -R $Repo -b $stripeSk }
if ($stripeWh) { gh secret set STRIPE_WEBHOOK_SECRET -R $Repo -b $stripeWh }

Write-Host "`nStep 3: Stripe webhook endpoint"
Write-Host "  Add in Stripe Dashboard -> Developers -> Webhooks:"
Write-Host "  URL: $WorkerUrl/webhook"
Write-Host "  Event: checkout.session.completed`n"

Write-Host "Step 4: Deploy worker locally (alternative to GitHub Action)"
Write-Host "  npx wrangler login"
Write-Host "  npx wrangler deploy"
Write-Host "  npx wrangler secret put STRIPE_SECRET_KEY"
Write-Host "  npx wrangler secret put STRIPE_WEBHOOK_SECRET`n"

Write-Host "Or trigger GitHub Action deploy:" -ForegroundColor Green
Write-Host "  gh workflow run deploy-worker.yml -R $Repo`n"

Write-Host "Live site: https://gshaheed.github.io/desi-fruit-finder/" -ForegroundColor Green
Write-Host "Checkout endpoint: $WorkerUrl/create-checkout`n"
