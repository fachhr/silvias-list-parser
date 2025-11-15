# Silvia's List - CV Parser Service

AI-powered CV parsing service for extracting structured data from resumes. This service is deployed on Railway and handles asynchronous CV processing for the Silvia's List talent pool platform.

## Features

- 🤖 **AI-Powered Extraction**: Uses OpenAI GPT-4o for intelligent CV parsing
- 📸 **Profile Picture Detection**: AI vision-based profile picture extraction
- 📄 **Multi-Format Support**: Handles PDF and DOCX files
- 🔄 **Two-Pass Parsing**: Enhanced accuracy for uncertain fields
- 🧠 **Field Inference**: Automatically infers missing data from context
- ✅ **Data Validation**: Validates and normalizes extracted data
- 🔒 **Secure**: API key authentication
- 📊 **Comprehensive Extraction**: Extracts 40+ profile fields

## Tech Stack

- **Runtime**: Node.js
- **Framework**: Express.js
- **AI/ML**: OpenAI GPT-4o, OpenAI Vision API
- **PDF Parsing**: pdf-parse
- **DOCX Parsing**: mammoth
- **Image Processing**: sharp, pdf-lib
- **Database**: Supabase (PostgreSQL)
- **Storage**: Supabase Storage
- **Deployment**: Railway

## Extracted Fields

### Contact Information
- Full name, first name, last name
- Email address
- Phone number (with country code)
- Physical address (street, city, state, country, zip)
- LinkedIn, GitHub, Portfolio URLs

### Professional Info
- Years of experience
- Education history (degree, institution, dates, GPA, honors, etc.)
- Work experience (company, title, dates, responsibilities)
- Technical skills
- Soft skills
- Industry-specific skills
- Languages with proficiency levels

### Additional Data
- Certifications (with dates and credentials)
- Projects (with technologies used)
- Publications (for academic CVs)
- Extracurricular activities
- Professional interests
- Profile picture (extracted via AI vision)

### Academic CV Specific
- Research interests
- h-index, total citations
- ORCID ID, Google Scholar URL
- Teaching experience
- Research grants
- Conference presentations
- Academic service
- Peer review activities

### Career Start CV Specific
- Cumulative GPA, Major GPA
- Internship experiences
- Academic projects
- Campus leadership
- Competitions & hackathons
- Volunteer experience

## Getting Started

### Prerequisites

- Node.js 18+ installed
- Supabase project with talent pool schema
- OpenAI API key with GPT-4o access

### Installation

1. Clone the repository:
```bash
git clone https://github.com/your-username/silvias-list-parser.git
cd silvias-list-parser
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables:
```bash
cp .env.example .env
```

Edit `.env` with your actual credentials:
```bash
# Required
INTERNAL_API_KEY="generate-strong-random-key"
SUPABASE_URL="https://your-project.supabase.co"
SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"
OPENAI_API_KEY="sk-proj-your-key"

# Optional (recommended defaults shown)
CONFIDENCE_THRESHOLD=70
ENABLE_TWO_PASS=true
ENABLE_INFERENCE=true
ENABLE_PROFILE_PICTURE_EXTRACTION=true
VISION_API_TIMEOUT_MS=10000
MIN_CONFIDENCE_THRESHOLD=60
PORT=3002
```

4. Run the service:
```bash
node index.js
```

The service will start on `http://localhost:3002`

## API Endpoints

### POST /parse

Main CV parsing endpoint.

**Headers:**
- `x-api-key`: Your INTERNAL_API_KEY
- `Content-Type`: application/json

**Request Body:**
```json
{
  "profileId": "uuid-of-profile",
  "cvStoragePath": "talent-pool-cvs/uuid/cv.pdf",
  "email": "user@example.com"
}
```

**Response:**
```json
{
  "success": true,
  "profileId": "uuid-of-profile",
  "message": "CV parsed successfully",
  "extractedFields": 42
}
```

**Error Response:**
```json
{
  "success": false,
  "error": "Error message",
  "details": "Detailed error information"
}
```

### GET /health

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2025-01-15T17:00:00.000Z",
  "uptime": 3600.5,
  "service": "silv ias-list-parser",
  "version": "1.0.0"
}
```

## How It Works

### 1. CV Upload Flow

```
Frontend → Supabase Storage → user_profiles Record Created (17 fields)
                ↓
         Parser Service Triggered (async, non-blocking)
                ↓
         Download CV from Storage
                ↓
         Extract Text (PDF/DOCX)
                ↓
         AI Parsing (OpenAI GPT-4o)
                ↓
         Profile Picture Extraction (Vision API)
                ↓
         Data Validation & Normalization
                ↓
         Update cv_parsing_jobs (status='completed', extracted_data)
                ↓
         🔥 DATABASE TRIGGER FIRES AUTOMATICALLY 🔥
                ↓
         Sync extracted_data → user_profiles (+ 14 fields)
                ↓
         Set parsing_completed_at timestamp
                ↓
         ✅ Complete profile ready (31 fields total)
```

**Key Architecture Decision:**
- Parser writes to `cv_parsing_jobs.extracted_data` (JSONB)
- PostgreSQL trigger automatically syncs to `user_profiles`
- Separation of concerns: Parser doesn't directly modify user_profiles
- Atomic transactions: Either all fields sync or none

### 2. Two-Pass Parsing

For fields with low confidence (< threshold):
1. **First Pass**: General extraction from entire CV
2. **Uncertainty Detection**: Identify fields below confidence threshold
3. **Second Pass**: Focused re-extraction with specific prompts
4. **Merge Results**: Combine high-confidence results

### 3. Field Inference

When direct extraction fails:
- Calculate `years_of_experience` from work history dates
- Infer `contact_address` from header/footer information
- Detect `active_cv_type` from content structure
- Extract social links from various formats

### 4. Profile Picture Extraction

1. Extract all images from PDF/DOCX
2. Filter by size (min 100x100px)
3. AI vision analysis to identify profile pictures
4. Exclude logos, charts, diagrams
5. Confidence scoring (min 60%)
6. Optimize and upload to Supabase Storage

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `INTERNAL_API_KEY` | ✅ Yes | - | API key for authentication |
| `SUPABASE_URL` | ✅ Yes | - | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ Yes | - | Supabase service key |
| `OPENAI_API_KEY` | ✅ Yes | - | OpenAI API key |
| `CONFIDENCE_THRESHOLD` | No | 70 | Min confidence % for fields |
| `ENABLE_TWO_PASS` | No | true | Enable two-pass parsing |
| `ENABLE_INFERENCE` | No | true | Enable field inference |
| `ENABLE_PROFILE_PICTURE_EXTRACTION` | No | true | Enable AI picture extraction |
| `VISION_API_TIMEOUT_MS` | No | 10000 | Vision API timeout |
| `MIN_CONFIDENCE_THRESHOLD` | No | 60 | Min % for picture detection |
| `PORT` | No | 3002 | Server port |

## Database Setup

### Deploy PostgreSQL Trigger

**IMPORTANT:** Before deploying the parser, you must install the database trigger in Supabase.

1. Open Supabase Dashboard → SQL Editor
2. Copy contents of `database/sync_trigger.sql`
3. Execute the SQL script
4. Verify trigger installation:
```sql
SELECT trigger_name, event_manipulation, event_object_table
FROM information_schema.triggers
WHERE trigger_name = 'trigger_sync_parsed_cv_data';
```

This trigger automatically syncs parsed CV data from `cv_parsing_jobs` to `user_profiles` when parsing completes.

## Deployment to Railway

### Quick Deploy

1. Push code to GitHub

2. **Deploy database trigger** (see Database Setup above)

3. Create new Railway project:
   - Go to [Railway.app](https://railway.app)
   - Click "New Project"
   - Select "Deploy from GitHub repo"
   - Choose `silvias-list-parser`

4. Configure environment variables:
   - Go to project → Variables
   - Add all required variables from `.env.example`

5. Deploy:
   - Railway auto-deploys on push
   - Get your service URL: `https://your-app.railway.app`

6. Test:
```bash
curl https://your-app.railway.app/health
```

### Manual Deploy

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Link project
railway link

# Deploy
railway up
```

## Monitoring & Logs

### Railway Dashboard
- View logs in real-time
- Monitor memory/CPU usage
- Track request metrics
- Set up alerts

### Logging

The service logs:
- ✅ Successful parsing operations
- ❌ Errors with stack traces
- ⚠️ Low confidence warnings
- 📊 Extraction statistics
- 🖼️ Profile picture detection results

Example log output:
```
[2025-01-15T17:00:00Z] INFO: Received parse request for profile abc-123
[2025-01-15T17:00:01Z] INFO: Downloaded CV from storage: 2.3MB PDF
[2025-01-15T17:00:05Z] INFO: Text extraction complete: 1,542 words
[2025-01-15T17:00:15Z] INFO: First pass parsing complete: 38/42 fields (90% confidence)
[2025-01-15T17:00:18Z] INFO: Second pass for 4 uncertain fields
[2025-01-15T17:00:22Z] INFO: Profile picture extracted with 85% confidence
[2025-01-15T17:00:23Z] INFO: Database updated successfully
[2025-01-15T17:00:23Z] SUCCESS: Parsing complete for profile abc-123 (23.1s total)
```

## Error Handling

The parser handles:
- ✅ Corrupted PDF/DOCX files
- ✅ Files with no text content
- ✅ Missing required fields
- ✅ OpenAI API failures (with retries)
- ✅ Network timeouts
- ✅ Supabase connection errors
- ✅ Invalid file formats

Errors are logged and reported back to the database with error messages.

## Performance

**Typical Parsing Times:**
- Simple CV (1 page): ~10-15 seconds
- Standard CV (2-3 pages): ~15-25 seconds
- Complex CV (4+ pages): ~25-40 seconds
- Academic CV with publications: ~30-50 seconds

**Factors affecting speed:**
- CV length and complexity
- OpenAI API response time
- Profile picture count/size
- Two-pass parsing (adds 5-10s)

## Testing

### Test Locally

```bash
# Start service
node index.js

# In another terminal, test with curl
curl -X POST http://localhost:3002/parse \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-api-key" \
  -d '{
    "profileId": "test-uuid",
    "cvStoragePath": "talent-pool-cvs/test-uuid/cv.pdf",
    "email": "test@example.com"
  }'
```

### Test on Railway

```bash
curl -X POST https://your-app.railway.app/parse \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-api-key" \
  -d '{
    "profileId": "test-uuid",
    "cvStoragePath": "talent-pool-cvs/test-uuid/cv.pdf",
    "email": "test@example.com"
  }'
```

## Security

- ✅ API key authentication on all endpoints
- ✅ Supabase service role key (server-side only)
- ✅ No PII in logs
- ✅ Secure file handling
- ✅ Input validation
- ✅ Rate limiting (recommended via Railway)

**Best Practices:**
- Use strong random API keys (32+ characters)
- Rotate keys regularly
- Never commit `.env` to git
- Use Railway's secret management
- Enable HTTPS only (Railway default)

## Troubleshooting

### Parser not receiving requests
- Check Railway logs for errors
- Verify INTERNAL_API_KEY matches frontend
- Ensure Railway app is deployed and running

### OpenAI API errors
- Verify API key is valid and has GPT-4o access
- Check API quota and billing
- Monitor rate limits

### Supabase connection errors
- Verify SUPABASE_URL is correct
- Check SUPABASE_SERVICE_ROLE_KEY (not anon key!)
- Ensure database schema is up to date

### Profile picture not extracting
- Check ENABLE_PROFILE_PICTURE_EXTRACTION=true
- Verify CV actually contains an image
- Check logs for confidence scores
- Try lowering MIN_CONFIDENCE_THRESHOLD

### Parsing takes too long
- Check OpenAI API latency
- Consider disabling ENABLE_TWO_PASS for faster results
- Reduce VISION_API_TIMEOUT_MS if picture extraction hangs

## Dependencies

```json
{
  "express": "^4.18.2",
  "@supabase/supabase-js": "^2.45.0",
  "openai": "^4.71.1",
  "pdf-parse": "^1.1.1",
  "mammoth": "^1.8.0",
  "pdf-lib": "^1.17.1",
  "sharp": "^0.33.5",
  "dotenv": "^16.4.7"
}
```

## Support

For issues or questions:
- Check Railway logs first
- Review error messages in database
- Contact: [your-email@example.com]

## License

Private - All Rights Reserved

---

**Version**: 1.0.0
**Last Updated**: 2025-01-15
**Maintained By**: Silvia's List Team
