#!/bin/bash
# Azure Setup Script for SetSelect CV Parser
# Run these commands sequentially after: az login

set -e

# ==========================================
# 1. Resource Group
# ==========================================
az group create --name rg-setselect-parser --location switzerlandnorth

# ==========================================
# 2. Container Registry
# ==========================================
az acr create --name acrsetselect --resource-group rg-setselect-parser \
  --sku Basic --location switzerlandnorth --admin-enabled true

# ==========================================
# 3. Azure OpenAI Account
# ==========================================
# If this fails due to model availability, change --location to swedencentral
az cognitiveservices account create --name aoai-setselect \
  --resource-group rg-setselect-parser --kind OpenAI --sku S0 \
  --location switzerlandnorth --yes

# ==========================================
# 4. Check Model Availability & Deploy Models
# ==========================================
az cognitiveservices model list --location switzerlandnorth -o table

# GPT-4o for CV text parsing
az cognitiveservices account deployment create --name aoai-setselect \
  --resource-group rg-setselect-parser --deployment-name gpt-4o \
  --model-name gpt-4o --model-version "2024-08-06" \
  --model-format OpenAI --sku-capacity 80 --sku-name Standard

# GPT-4o-mini for vision + summaries
az cognitiveservices account deployment create --name aoai-setselect \
  --resource-group rg-setselect-parser --deployment-name gpt-4o-mini \
  --model-name gpt-4o-mini --model-version "2024-07-18" \
  --model-format OpenAI --sku-capacity 120 --sku-name Standard

# ==========================================
# 5. Get Azure OpenAI Key & Endpoint
# ==========================================
AOAI_ENDPOINT=$(az cognitiveservices account show --name aoai-setselect \
  --resource-group rg-setselect-parser --query properties.endpoint -o tsv)
echo "Endpoint: $AOAI_ENDPOINT"

AOAI_KEY=$(az cognitiveservices account keys list --name aoai-setselect \
  --resource-group rg-setselect-parser --query key1 -o tsv)
echo "Key: $AOAI_KEY"

# ==========================================
# 6. Log Analytics + Container Apps Environment
# ==========================================
az monitor log-analytics workspace create \
  --resource-group rg-setselect-parser \
  --workspace-name law-setselect \
  --location switzerlandnorth

WORKSPACE_ID=$(az monitor log-analytics workspace show \
  --resource-group rg-setselect-parser --workspace-name law-setselect \
  --query customerId -o tsv)

WORKSPACE_KEY=$(az monitor log-analytics workspace get-shared-keys \
  --resource-group rg-setselect-parser --workspace-name law-setselect \
  --query primarySharedKey -o tsv)

az containerapp env create --name cae-setselect \
  --resource-group rg-setselect-parser --location switzerlandnorth \
  --logs-workspace-id "$WORKSPACE_ID" --logs-workspace-key "$WORKSPACE_KEY"

# ==========================================
# 7. Service Principal for GitHub Actions
# ==========================================
SUBSCRIPTION_ID=$(az account show --query id -o tsv)

echo "--- Copy the JSON below into GitHub secret AZURE_CREDENTIALS ---"
az ad sp create-for-rbac --name sp-setselect-deploy \
  --role contributor \
  --scopes /subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-setselect-parser \
  --sdk-auth

# ==========================================
# 8. Get ACR Credentials (for GitHub secrets)
# ==========================================
echo "--- ACR_USERNAME ---"
az acr credential show --name acrsetselect --query username -o tsv

echo "--- ACR_PASSWORD ---"
az acr credential show --name acrsetselect --query "passwords[0].value" -o tsv

# ==========================================
# 9. Create Container App
# ==========================================
# IMPORTANT: Replace <VALUE> placeholders below before running

# az containerapp create \
#   --name ca-cv-parser \
#   --resource-group rg-setselect-parser \
#   --environment cae-setselect \
#   --image acrsetselect.azurecr.io/cv-parser:latest \
#   --registry-server acrsetselect.azurecr.io \
#   --target-port 3002 --ingress external \
#   --min-replicas 1 --max-replicas 3 \
#   --cpu 1.0 --memory 2.0Gi \
#   --secrets \
#     internal-api-key="<VALUE>" \
#     supabase-url="<VALUE>" \
#     supabase-service-role-key="<VALUE>" \
#     azure-openai-api-key="$AOAI_KEY" \
#     azure-openai-endpoint="$AOAI_ENDPOINT" \
#   --env-vars \
#     INTERNAL_API_KEY=secretref:internal-api-key \
#     SUPABASE_URL=secretref:supabase-url \
#     SUPABASE_SERVICE_ROLE_KEY=secretref:supabase-service-role-key \
#     AZURE_OPENAI_API_KEY=secretref:azure-openai-api-key \
#     AZURE_OPENAI_ENDPOINT=secretref:azure-openai-endpoint \
#     AZURE_OPENAI_API_VERSION="2024-10-21" \
#     AZURE_OPENAI_DEPLOYMENT_PARSING="gpt-4o" \
#     CONFIDENCE_THRESHOLD="70" \
#     ENABLE_TWO_PASS="true" \
#     ENABLE_INFERENCE="true" \
#     ENABLE_PROFILE_PICTURE_EXTRACTION="true" \
#     VISION_API_TIMEOUT_MS="10000" \
#     MIN_CONFIDENCE_THRESHOLD="60" \
#     PORT="3002"

# ==========================================
# 10. Verify
# ==========================================
# FQDN=$(az containerapp show --name ca-cv-parser --resource-group rg-setselect-parser \
#   --query properties.configuration.ingress.fqdn -o tsv)
# curl "https://$FQDN/health"
# az containerapp logs show --name ca-cv-parser --resource-group rg-setselect-parser
