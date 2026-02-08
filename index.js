import express from 'express';
import { createClient } from '@supabase/supabase-js';
import OpenAI, { AzureOpenAI } from 'openai';
import pdf from 'pdf-parse/lib/pdf-parse.js';
import mammoth from 'mammoth';
import { PDFDocument, PDFName } from 'pdf-lib';
import sharp from 'sharp';

// Import ALL shared options from local config file
import {
  COUNTRY_OPTIONS,
  GENERAL_FIELD_OPTIONS,
  SPECIFIC_FIELD_OPTIONS,
  DEGREE_TYPE_OPTIONS,
  POSITION_TYPE_OPTIONS,
  LANGUAGE_PROFICIENCY_OPTIONS,
  SKILL_PROFICIENCY_OPTIONS,
  INDUSTRY_SKILL_OPTIONS,
  DURATION_OPTIONS,
  JOB_TYPE_OPTIONS,
  LOCATION_OPTIONS,
  INDUSTRY_PREFERENCE_OPTIONS,
  FUNCTIONAL_EXPERTISE_OPTIONS,
} from './formOptions.js';

// ==========================================
// INITIALIZATION
// ==========================================
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3002;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
const ENABLE_TWO_PASS = process.env.ENABLE_TWO_PASS !== 'false'; // Default true
const ENABLE_INFERENCE = process.env.ENABLE_INFERENCE !== 'false'; // Default true
const ENABLE_PROFILE_PICTURE_EXTRACTION = process.env.ENABLE_PROFILE_PICTURE_EXTRACTION !== 'false'; // Default true
const VISION_API_TIMEOUT_MS = parseInt(process.env.VISION_API_TIMEOUT_MS) || 10000; // 10 seconds
const MIN_CONFIDENCE_THRESHOLD = parseInt(process.env.MIN_CONFIDENCE_THRESHOLD) || 60; // 60%

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const useAzureOpenAI = !!process.env.AZURE_OPENAI_ENDPOINT;
const openai = useAzureOpenAI
  ? new AzureOpenAI({
      apiKey: process.env.AZURE_OPENAI_API_KEY,
      endpoint: process.env.AZURE_OPENAI_ENDPOINT,
      apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-10-21',
      deployment: process.env.AZURE_OPENAI_DEPLOYMENT_PARSING || 'gpt-4o',
    })
  : new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ==========================================
// CONSTANTS
// ==========================================

// Image extraction and processing
const IMAGE_MIN_SIZE = 100; // Minimum width/height in pixels to consider
const IMAGE_MAX_DIMENSION = 800; // Maximum dimension for resized images
const IMAGE_JPEG_QUALITY = 85; // JPEG compression quality (0-100)
const IMAGE_MAX_CANDIDATES = 5; // Max images to analyze with Vision API
const PDF_MAX_PAGES_TO_SCAN = 2; // Only scan first N pages for images

// OpenAI API configuration
const OPENAI_MODEL_PARSING = 'gpt-4o'; // Model for CV text parsing
const OPENAI_MODEL_VISION = 'gpt-4o-mini'; // Model for image analysis
const OPENAI_TEMP_PARSING = 0; // Temperature for parsing (0 = fully deterministic for consistent company classification)
const OPENAI_TEMP_VISION = 0.3; // Temperature for vision analysis
const OPENAI_MAX_TOKENS_VISION = 200; // Max tokens for vision response

// ==========================================
// HELPER FUNCTIONS
// ==========================================

// Convert options array to string for prompt
const getOptionsString = (optionsArray) => {
  return optionsArray
    .map(opt => opt.value)
    .filter(Boolean)
    .map(val => `'${val}'`)
    .join(', ');
};

// Convert simple string array to options string
const getOptionsStringForSimpleArray = (optionsArray) => {
  return optionsArray
    .filter(Boolean)
    .map(val => `'${val}'`)
    .join(', ');
};

// Convert file to text
async function convertFileToText(storagePath) {
  const { data, error } = await supabase.storage.from('talent-pool-cvs').download(storagePath);

  if (error) {
    console.error(`[ERROR] Failed to download CV from storage: ${error.message}`, { storagePath });
    throw new Error(`Storage download failed: ${error.message}`);
  }

  const buffer = Buffer.from(await data.arrayBuffer());
  if (storagePath.toLowerCase().endsWith('.pdf')) {
    const pdfData = await pdf(buffer);
    return pdfData.text;
  } else if (storagePath.toLowerCase().endsWith('.docx')) {
    const { value } = await mammoth.extractRawText({ buffer });
    return value;
  } else {
    throw new Error('Unsupported file type. Please upload a PDF or DOCX file.');
  }
}

// ==========================================
// PROFILE PICTURE EXTRACTION
// ==========================================

/**
 * Extract images from a PDF file
 * @param {Buffer} buffer - PDF file buffer
 * @returns {Promise<Array<{buffer: Buffer, width: number, height: number, page: number}>>}
 */
async function extractImagesFromPdf(buffer) {
  try {
    const pdfDoc = await PDFDocument.load(buffer);
    const pages = pdfDoc.getPages();
    const extractedImages = [];

    // Only process first pages (profile pictures are typically on page 1)
    const pagesToProcess = Math.min(pages.length, PDF_MAX_PAGES_TO_SCAN);

    for (let pageIndex = 0; pageIndex < pagesToProcess; pageIndex++) {
      const page = pages[pageIndex];

      // Get page resources
      const resources = page.node.Resources();
      const xObjects = resources?.lookup(PDFName.of('XObject'));

      if (!xObjects) continue;

      // Iterate through XObjects (which include images)
      const xObjectKeys = xObjects.dict.keys();

      for (const key of xObjectKeys) {
        try {
          const xObject = xObjects.lookup(key);

          // Check if this is an image
          const subtype = xObject?.dict?.get(PDFName.of('Subtype'));
          if (subtype?.toString() !== '/Image') continue;

          // Get image dimensions
          const width = xObject?.dict?.get(PDFName.of('Width'))?.value;
          const height = xObject?.dict?.get(PDFName.of('Height'))?.value;

          // Filter out small images (likely icons/logos)
          if (!width || !height || width < IMAGE_MIN_SIZE || height < IMAGE_MIN_SIZE) continue;

          // Get image data
          const imageData = xObject?.contents;
          if (!imageData) continue;

          // Convert to Buffer and optimize with sharp
          const imageBuffer = Buffer.from(imageData);
          const optimizedImage = await sharp(imageBuffer)
            .resize(IMAGE_MAX_DIMENSION, IMAGE_MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: IMAGE_JPEG_QUALITY })
            .toBuffer();

          const metadata = await sharp(optimizedImage).metadata();

          extractedImages.push({
            buffer: optimizedImage,
            width: metadata.width,
            height: metadata.height,
            page: pageIndex + 1
          });
        } catch (err) {
          // Skip individual image extraction errors silently
          continue;
        }
      }
    }

    return extractedImages;
  } catch (error) {
    console.error('[ERROR] PDF image extraction failed:', error.message);
    return [];
  }
}

/**
 * Extract images from a DOCX file
 * @param {Buffer} buffer - DOCX file buffer
 * @returns {Promise<Array<{buffer: Buffer, width: number, height: number}>>}
 */
async function extractImagesFromDocx(buffer) {
  try {
    const extractedImages = [];

    // Configure mammoth to extract images
    const result = await mammoth.convertToHtml({
      buffer,
    }, {
      convertImage: mammoth.images.imgElement(async (image) => {
        try {
          const imageBuffer = await image.read();

          // Get image metadata
          const metadata = await sharp(imageBuffer).metadata();

          // Filter out small images (likely icons/logos)
          if (metadata.width < IMAGE_MIN_SIZE || metadata.height < IMAGE_MIN_SIZE) {
            return { src: '' }; // Skip small images
          }

          // Optimize image
          const optimizedImage = await sharp(imageBuffer)
            .resize(IMAGE_MAX_DIMENSION, IMAGE_MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: IMAGE_JPEG_QUALITY })
            .toBuffer();

          const optimizedMetadata = await sharp(optimizedImage).metadata();

          extractedImages.push({
            buffer: optimizedImage,
            width: optimizedMetadata.width,
            height: optimizedMetadata.height
          });

          return { src: '' }; // We don't need the HTML, just extracting images
        } catch (err) {
          // Skip individual image errors silently
          return { src: '' };
        }
      })
    });

    return extractedImages;
  } catch (error) {
    console.error('[ERROR] DOCX image extraction failed:', error.message);
    return [];
  }
}

/**
 * Use OpenAI Vision API to identify the most likely profile picture from extracted images
 * @param {Array<{buffer: Buffer, width: number, height: number}>} images - Array of extracted images
 * @returns {Promise<{imageIndex: number|null, confidence: number, reason: string}>}
 */
async function identifyProfilePicture(images) {
  if (!images || images.length === 0) {
    return { imageIndex: null, confidence: 0, reason: 'No images found' };
  }

  try {
    // Convert first candidate images to base64 (to limit API cost)
    const candidateImages = images.slice(0, IMAGE_MAX_CANDIDATES);
    const base64Images = candidateImages.map((img) => ({
      base64: img.buffer.toString('base64'),
      dimensions: `${img.width}x${img.height}`
    }));

    // Create image content for Vision API (multiple images in one call)
    const imageContent = base64Images.map((img, index) => ({
      type: 'image_url',
      image_url: {
        url: `data:image/jpeg;base64,${img.base64}`,
        detail: 'low' // Use low detail to reduce cost
      }
    }));

    const prompt = `Analyze these ${base64Images.length} images extracted from a CV/resume. Your task is to identify which one is most likely a professional profile picture of the person who wrote the CV.

Consider the following criteria:
1. Contains a human face (headshot or upper body)
2. Professional appearance (not casual snapshots)
3. Appropriate composition for a profile picture
4. Person is the main subject (not a group photo)
5. Clear, well-lit image

The images are numbered 1 to ${base64Images.length}.

Respond with JSON only, in this exact format:
{
  "hasProfilePicture": true or false,
  "imageIndex": <1-based index of the best candidate, or null if none>,
  "confidence": <0-100 integer>,
  "reason": "<brief explanation>"
}

If none of the images appear to be a professional profile picture (e.g., they're logos, charts, diagrams, group photos, or casual snapshots), set hasProfilePicture to false and imageIndex to null.`;

    // Call OpenAI Vision API with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), VISION_API_TIMEOUT_MS);

    try {
      const response = await openai.chat.completions.create({
        model: OPENAI_MODEL_VISION,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              ...imageContent
            ]
          }
        ],
        max_tokens: OPENAI_MAX_TOKENS_VISION,
        temperature: OPENAI_TEMP_VISION,
      }, {
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      // Parse response
      const content = response.choices[0]?.message?.content?.trim();
      if (!content) {
        return { imageIndex: null, confidence: 0, reason: 'Empty response from Vision API' };
      }

      // Extract JSON from response (handle markdown code blocks)
      let jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { imageIndex: null, confidence: 0, reason: 'Failed to parse Vision API response' };
      }

      const result = JSON.parse(jsonMatch[0]);

      // Convert 1-based index to 0-based, validate
      const imageIndex = result.hasProfilePicture && result.imageIndex
        ? result.imageIndex - 1
        : null;

      // Validate index is within bounds
      if (imageIndex !== null && (imageIndex < 0 || imageIndex >= images.length)) {
        return { imageIndex: null, confidence: 0, reason: 'Invalid image index from API' };
      }

      return {
        imageIndex,
        confidence: result.confidence || 0,
        reason: result.reason || 'No reason provided'
      };

    } catch (apiError) {
      clearTimeout(timeoutId);
      if (apiError.name === 'AbortError') {
        return { imageIndex: null, confidence: 0, reason: 'Vision API timeout' };
      }
      throw apiError;
    }

  } catch (error) {
    console.error('[ERROR] Vision API error:', error.message);
    return { imageIndex: null, confidence: 0, reason: `Error: ${error.message}` };
  }
}

/**
 * Upload profile picture to Supabase Storage
 * @param {Buffer} imageBuffer - Image buffer
 * @param {string} userId - User ID (clerkUserId for profile CV, or sessionId for quick CV)
 * @param {boolean} isQuickCV - Whether this is for Quick CV (determines storage path)
 * @returns {Promise<string|null>} - Storage path or null if upload failed
 */
async function uploadProfilePictureToStorage(imageBuffer, userId, isQuickCV = false) {
  try {
    // Generate unique filename
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).substring(7);
    const filename = `${timestamp}-${randomSuffix}.jpg`;

    // Determine storage path
    const folder = isQuickCV ? 'quick-temp' : userId;
    const storagePath = `${folder}/${filename}`;

    // Upload to profile-pictures bucket
    const { data, error } = await supabase.storage
      .from('profile-pictures')
      .upload(storagePath, imageBuffer, {
        contentType: 'image/jpeg',
        upsert: false
      });

    if (error) {
      console.error('[ERROR] Profile picture upload failed:', error.message);
      return null;
    }

    return storagePath;

  } catch (error) {
    console.error('[ERROR] Profile picture upload error:', error.message);
    return null;
  }
}

/**
 * Main orchestrator function to extract profile picture from CV
 * @param {string} storagePath - Path to CV in raw-cvs bucket
 * @param {string} userId - User ID (clerkUserId or sessionId)
 * @param {boolean} isQuickCV - Whether this is for Quick CV
 * @returns {Promise<string|null>} - Storage path of extracted profile picture, or null
 */
async function extractProfilePicture(storagePath, userId, isQuickCV = false) {
  if (!ENABLE_PROFILE_PICTURE_EXTRACTION) {
    return null;
  }

  const startTime = Date.now();

  try {
    // Download file from storage
    const { data, error } = await supabase.storage.from('talent-pool-cvs').download(storagePath);

    if (error) {
      console.error('[extractProfilePicture] Download error:', error);
      return null;
    }

    const buffer = Buffer.from(await data.arrayBuffer());
    const isPdf = storagePath.toLowerCase().endsWith('.pdf');
    const isDocx = storagePath.toLowerCase().endsWith('.docx');

    // Extract images based on file type
    let extractedImages = [];

    if (isPdf) {
      extractedImages = await extractImagesFromPdf(buffer);
    } else if (isDocx) {
      extractedImages = await extractImagesFromDocx(buffer);
    } else {
      return null;
    }

    if (extractedImages.length === 0) {
      return null;
    }

    // Use AI to identify the best profile picture
    const identification = await identifyProfilePicture(extractedImages);

    // Check if confidence meets threshold
    if (identification.imageIndex === null || identification.confidence < MIN_CONFIDENCE_THRESHOLD) {
      return null;
    }

    // Get the identified image
    const selectedImage = extractedImages[identification.imageIndex];

    // Upload to storage
    const uploadedPath = await uploadProfilePictureToStorage(selectedImage.buffer, userId, isQuickCV);

    return uploadedPath;

  } catch (error) {
    console.error('[ERROR] Profile picture extraction failed:', error.message);
    return null; // Graceful degradation - don't fail the entire parsing job
  }
}

// ==========================================
// VALIDATION & AUTO-CORRECTION
// ==========================================

// Validate and auto-correct URL (ensure https:// prefix)
function validateAndCorrectUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    return 'https://' + trimmed;
  }
  return trimmed;
}

// Validate and correct phone country code (ensure + prefix)
function validateAndCorrectCountryCode(code) {
  if (!code || typeof code !== 'string') return null;
  const trimmed = code.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('+')) {
    return '+' + trimmed;
  }
  return trimmed;
}

// Validate and standardize date format to YYYY-MM
function validateAndCorrectDate(dateString) {
  if (!dateString || typeof dateString !== 'string') return null;
  const trimmed = dateString.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed === 'present') return 'present'; // Normalize to lowercase

  // Handle various date formats
  // Format: MM/YYYY or MM-YYYY -> YYYY-MM
  const monthYearMatch = trimmed.match(/^(\d{1,2})[\/\-](\d{4})$/);
  if (monthYearMatch) {
    const month = monthYearMatch[1].padStart(2, '0');
    const year = monthYearMatch[2];
    return `${year}-${month}`;
  }

  // Format: YYYY-MM (already correct)
  if (/^\d{4}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  // Format: YYYY only -> YYYY-01
  if (/^\d{4}$/.test(trimmed)) {
    return `${trimmed}-01`;
  }

  return trimmed; // Return as-is if can't parse
}

// Validate email format
function validateEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email.trim()) ? email.trim() : null;
}

// Fuzzy match string to closest option from array
function fuzzyMatchToOptions(value, optionsArray, threshold = 0.7) {
  if (!value || typeof value !== 'string') return null;

  const valueLower = value.toLowerCase().trim();
  const options = optionsArray.map(opt =>
    typeof opt === 'string' ? opt : opt.value
  ).filter(Boolean);

  // Exact match (case-insensitive)
  const exactMatch = options.find(opt => opt.toLowerCase() === valueLower);
  if (exactMatch) return exactMatch;

  // Partial match - find if value is contained in option or vice versa
  const partialMatch = options.find(opt => {
    const optLower = opt.toLowerCase();
    return optLower.includes(valueLower) || valueLower.includes(optLower);
  });
  if (partialMatch) return partialMatch;

  // Common mappings for countries
  const countryMappings = {
    'usa': 'United States',
    'uk': 'United Kingdom',
    'uae': 'United Arab Emirates',
  };
  if (countryMappings[valueLower]) {
    return countryMappings[valueLower];
  }

  return null; // No confident match
}

// Validate and correct a single field value based on its type and options
function validateFieldValue(fieldName, value, optionsArray = null) {
  if (value === null || value === undefined) return null;

  // URL fields
  if (['linkedinUrl', 'githubUrl', 'portfolioUrl', 'url'].includes(fieldName)) {
    return validateAndCorrectUrl(value);
  }

  // Email field
  if (fieldName === 'email') {
    return validateEmail(value);
  }

  // Country code
  if (fieldName === 'country_code') {
    return validateAndCorrectCountryCode(value);
  }

  // Date fields
  if (fieldName.toLowerCase().includes('date') || ['startDate', 'endDate'].includes(fieldName)) {
    return validateAndCorrectDate(value);
  }

  // Dropdown fields with options
  if (optionsArray && optionsArray.length > 0) {
    return fuzzyMatchToOptions(value, optionsArray);
  }

  return value;
}

// Apply validation and correction to all extracted data
function validateAndCorrectData(extractedData) {
  const corrected = { ...extractedData };
  const corrections = [];

  // Validate URLs
  ['linkedinUrl', 'githubUrl', 'portfolioUrl'].forEach(field => {
    if (corrected[field]) {
      const original = corrected[field];
      corrected[field] = validateAndCorrectUrl(original);
      if (corrected[field] !== original) {
        corrections.push(`Added https:// to ${field}`);
      }
    }
  });

  // Validate email
  if (corrected.email) {
    const original = corrected.email;
    corrected.email = validateEmail(original);
    if (!corrected.email) {
      corrections.push(`Removed invalid email: ${original}`);
    }
  }

  // Validate country code
  if (corrected.country_code) {
    const original = corrected.country_code;
    corrected.country_code = validateAndCorrectCountryCode(original);
    if (corrected.country_code !== original) {
      corrections.push(`Added + to country code`);
    }
  }

  // Note: years_of_experience is calculated from work history, not validated from AI extraction

  // Validate education history
  if (Array.isArray(corrected.education_history)) {
    corrected.education_history = corrected.education_history.map(edu => ({
      ...edu,
      degreeType: validateFieldValue('degreeType', edu.degreeType, DEGREE_TYPE_OPTIONS),
      generalField: validateFieldValue('generalField', edu.generalField, GENERAL_FIELD_OPTIONS),
      specificField: validateFieldValue('specificField', edu.specificField, SPECIFIC_FIELD_OPTIONS),
      country: validateFieldValue('country', edu.country, COUNTRY_OPTIONS),
      startDate: validateAndCorrectDate(edu.startDate),
      endDate: validateAndCorrectDate(edu.endDate),
    }));
  }

  // Validate professional experience
  if (Array.isArray(corrected.professional_experience)) {
    corrected.professional_experience = corrected.professional_experience.map(exp => ({
      ...exp,
      positionType: validateFieldValue('positionType', exp.positionType, POSITION_TYPE_OPTIONS),
      country: validateFieldValue('country', exp.country, COUNTRY_OPTIONS),
      startDate: validateAndCorrectDate(exp.startDate),
      endDate: validateAndCorrectDate(exp.endDate),
    }));
  }

  // Validate skills
  if (Array.isArray(corrected.technical_skills)) {
    corrected.technical_skills = corrected.technical_skills.map(skill => ({
      ...skill,
      level: validateFieldValue('level', skill.level, SKILL_PROFICIENCY_OPTIONS),
    }));
  }

  if (Array.isArray(corrected.soft_skills)) {
    corrected.soft_skills = corrected.soft_skills.map(skill => ({
      ...skill,
      level: validateFieldValue('level', skill.level, SKILL_PROFICIENCY_OPTIONS),
    }));
  }

  // Validate languages
  if (Array.isArray(corrected.base_languages)) {
    corrected.base_languages = corrected.base_languages.map(lang => ({
      ...lang,
      proficiency: validateFieldValue('proficiency', lang.proficiency, LANGUAGE_PROFICIENCY_OPTIONS),
    }));
  }

  // Validate certifications dates
  if (Array.isArray(corrected.certifications)) {
    corrected.certifications = corrected.certifications.map(cert => ({
      ...cert,
      dateObtained: validateAndCorrectDate(cert.dateObtained),
      expiryDate: validateAndCorrectDate(cert.expiryDate),
      url: validateAndCorrectUrl(cert.url),
    }));
  }

  // Validate job preferences
  if (corrected.desired_duration_months) {
    corrected.desired_duration_months = fuzzyMatchToOptions(
      corrected.desired_duration_months,
      DURATION_OPTIONS
    );
  }

  if (Array.isArray(corrected.desired_locations)) {
    corrected.desired_locations = corrected.desired_locations
      .map(loc => fuzzyMatchToOptions(loc, LOCATION_OPTIONS))
      .filter(Boolean);
  }

  if (Array.isArray(corrected.desired_industries)) {
    corrected.desired_industries = corrected.desired_industries
      .map(ind => fuzzyMatchToOptions(ind, INDUSTRY_PREFERENCE_OPTIONS))
      .filter(Boolean);
  }

  return { corrected, corrections };
}

// ==========================================
// FIELD INFERENCE LOGIC
// ==========================================

// Calculate total work experience in months from experience array
// Handles overlapping employment periods correctly (e.g., freelance + full-time)
function calculateTotalWorkMonths(experiences) {
  if (!Array.isArray(experiences) || experiences.length === 0) return 0;

  // Step 1: Parse all valid date ranges
  const ranges = [];

  for (const exp of experiences) {
    if (!exp.startDate) {
      // Log skipped entries for debugging
      if (exp.positionName) {
        console.log(`[calculateTotalWorkMonths] Skipping entry: missing startDate for "${exp.positionName}"`);
      }
      continue;
    }

    try {
      const start = new Date(exp.startDate + '-01');

      // Use current date if position is current, otherwise use endDate
      let end;
      if (exp.isCurrent === true) {
        end = new Date(); // Still working here
      } else if (exp.endDate && exp.endDate.toLowerCase() !== 'present') {
        end = new Date(exp.endDate + '-01');
      } else {
        end = new Date(); // Default to current date
      }

      // Validate date range
      if (start <= end) {
        ranges.push({ start, end });
      } else {
        console.log(`[calculateTotalWorkMonths] Skipping entry: invalid date range (start > end) for "${exp.positionName || 'unknown'}"`);
      }
    } catch (e) {
      // Skip if dates are invalid
      console.log(`[calculateTotalWorkMonths] Skipping entry: date parse error for "${exp.positionName || 'unknown'}"`);
      continue;
    }
  }

  if (ranges.length === 0) return 0;

  // Step 2: Sort ranges by start date
  ranges.sort((a, b) => a.start - b.start);

  // Step 3: Merge overlapping ranges
  const merged = [ranges[0]];

  for (let i = 1; i < ranges.length; i++) {
    const current = ranges[i];
    const last = merged[merged.length - 1];

    if (current.start <= last.end) {
      // Overlapping period - extend the end date if needed
      last.end = new Date(Math.max(last.end.getTime(), current.end.getTime()));
    } else {
      // Non-overlapping period - add as new range
      merged.push(current);
    }
  }

  // Step 4: Calculate total months from merged ranges
  let totalMonths = 0;

  for (const range of merged) {
    const months = (range.end.getFullYear() - range.start.getFullYear()) * 12
                  + (range.end.getMonth() - range.start.getMonth());
    totalMonths += Math.max(0, months);
  }

  return totalMonths;
}

// Convert months to years (integer)
function calculateYearsFromMonths(months) {
  if (typeof months !== 'number' || months < 0) return 0;
  return Math.floor(months / 12); // Simple: 0, 1, 2, 3, 4, 5...
}

// Infer years of experience if missing or uncertain
function inferYearsOfExperience(extractedData) {
  // ALWAYS calculate from work history for accuracy (don't trust OpenAI extraction)
  if (!extractedData.professional_experience || extractedData.professional_experience.length === 0) {
    console.log('[inferYearsOfExperience] No professional experience found, returning 0');
    return 0;
  }

  const totalMonths = calculateTotalWorkMonths(extractedData.professional_experience);
  const years = calculateYearsFromMonths(totalMonths);
  console.log(`[inferYearsOfExperience] Calculated ${totalMonths} months → ${years} years`);
  return years;
}

// Extract unique countries from experience/education
function extractUniqueCountries(items) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const countries = items
    .map(item => item?.country)
    .filter(Boolean)
    .filter((country, index, self) => self.indexOf(country) === index);
  return countries;
}

// Infer desired locations from work history if missing
function inferDesiredLocations(extractedData) {
  if (extractedData.desired_locations && extractedData.desired_locations.length > 0) {
    return extractedData.desired_locations; // Already has values
  }

  // Get countries from professional experience
  const workCountries = extractUniqueCountries(extractedData.professional_experience || []);

  // If only one country, likely wants to stay there
  if (workCountries.length === 1) {
    return workCountries;
  }

  return [];
}

// Infer position type from position name keywords
function inferPositionType(positionName) {
  if (!positionName) return null;

  const nameLower = positionName.toLowerCase();

  if (/intern/i.test(nameLower)) return 'Internship';
  if (/freelance|contractor|consultant/i.test(nameLower)) return 'Freelance';
  if (/part[- ]?time/i.test(nameLower)) return 'Part-time';
  if (/volunteer/i.test(nameLower)) return 'Volunteer';

  return 'Full-time'; // Default assumption
}

// Apply inference logic to fill missing fields
function applyInferenceLogic(extractedData) {
  const inferred = { ...extractedData };
  const inferences = [];

  // Always recalculate years of experience from work history for accuracy
  if (ENABLE_INFERENCE) {
    const originalValue = inferred.years_of_experience;
    inferred.years_of_experience = inferYearsOfExperience(inferred);
    if (originalValue !== inferred.years_of_experience) {
      inferences.push(`Calculated years_of_experience: ${inferred.years_of_experience} (was: ${originalValue || 'null'})`);
    } else {
      inferences.push(`Verified years_of_experience: ${inferred.years_of_experience}`);
    }
  }

  // Infer desired locations
  if (ENABLE_INFERENCE && (!inferred.desired_locations || inferred.desired_locations.length === 0)) {
    const inferredLocations = inferDesiredLocations(inferred);
    if (inferredLocations.length > 0) {
      inferred.desired_locations = inferredLocations;
      inferences.push(`Inferred desired_locations from work history`);
    }
  }

  // Infer position types if missing
  if (ENABLE_INFERENCE && Array.isArray(inferred.professional_experience)) {
    inferred.professional_experience = inferred.professional_experience.map(exp => {
      if (!exp.positionType) {
        const inferred_type = inferPositionType(exp.positionName);
        if (inferred_type) {
          inferences.push(`Inferred positionType for ${exp.positionName}: ${inferred_type}`);
        }
        return { ...exp, positionType: inferred_type };
      }
      return exp;
    });
  }

  return { inferred, inferences };
}

// ==========================================
// FUNCTIONAL EXPERTISE MERGE LOGIC
// ==========================================

/**
 * Validates and filters functional expertise to only valid categories
 * @param {Array} expertise - Array of expertise strings from parser or user
 * @returns {Array} - Filtered array of valid expertise categories
 */
function validateFunctionalExpertise(expertise) {
  if (!Array.isArray(expertise)) return [];

  return expertise.filter(item =>
    typeof item === 'string' &&
    FUNCTIONAL_EXPERTISE_OPTIONS.includes(item)
  );
}

/**
 * Merges user-selected expertise with parser-extracted expertise
 * User selections are the source of truth; parser supplements up to max of 8 total
 *
 * @param {Array} userExpertise - User-selected expertise from form (source of truth)
 * @param {Array} parserExpertise - Parser-extracted expertise from CV
 * @returns {Array} - Merged expertise array (max 8 items)
 */
function mergeFunctionalExpertise(userExpertise, parserExpertise) {
  const MAX_EXPERTISE = 8;

  // Validate both inputs
  const validUserExpertise = validateFunctionalExpertise(userExpertise);
  const validParserExpertise = validateFunctionalExpertise(parserExpertise);

  // Start with user selections (source of truth)
  const merged = [...validUserExpertise];

  // Add parser expertise that isn't already in user selections (up to max)
  for (const expertise of validParserExpertise) {
    if (merged.length >= MAX_EXPERTISE) break;
    if (!merged.includes(expertise)) {
      merged.push(expertise);
    }
  }

  return merged;
}

// ==========================================
// OPENAI PARSING PROMPTS
// ==========================================

// Create comprehensive first-pass parsing prompt
function createComprehensiveParsingPrompt(cvText) {
  if (!cvText || typeof cvText !== 'string') {
    throw new Error('Invalid CV text provided for parsing');
  }

  // Dynamically generate all possible option strings
  const countries = getOptionsString(COUNTRY_OPTIONS);
  const generalFields = getOptionsString(GENERAL_FIELD_OPTIONS);
  const specificFields = getOptionsString(SPECIFIC_FIELD_OPTIONS);
  const degreeTypes = getOptionsString(DEGREE_TYPE_OPTIONS);
  const positionTypes = getOptionsString(POSITION_TYPE_OPTIONS);
  const languageProficiencies = getOptionsString(LANGUAGE_PROFICIENCY_OPTIONS);
  const skillLevels = getOptionsString(SKILL_PROFICIENCY_OPTIONS);
  const industrySkills = getOptionsString(INDUSTRY_SKILL_OPTIONS);
  const durations = getOptionsString(DURATION_OPTIONS);
  const jobTypes = getOptionsStringForSimpleArray(JOB_TYPE_OPTIONS);
  const locations = getOptionsString(LOCATION_OPTIONS);
  const industries = getOptionsString(INDUSTRY_PREFERENCE_OPTIONS);

  const jsonStructure = `
  {
    "contact_first_name": "string | null",
    "contact_last_name": "string | null",
    "email": "string | null",
    "country_code": "string (e.g., '+41', '+1') | null",
    "phoneNumber": "string (local part only, without country code) | null",
    "contact_address": {
      "street": "string | null",
      "city": "string | null",
      "state": "string | null",
      "country": "string (${countries}) | null",
      "zip": "string | null"
    } | null,
    "linkedinUrl": "string (full URL) | null",
    "githubUrl": "string (full URL) | null",
    "portfolioUrl": "string (full URL) | null",
    "years_of_experience": "number (integer, e.g., 0, 1, 2, 3, 5, 10) | null",
    "education_history": [{
      "universityName": "string",
      "degreeType": "string (${degreeTypes}) | null",
      "generalField": "string (${generalFields}) | null",
      "specificField": "string (${specificFields}) | null",
      "overallGrade": "string (e.g., 'First Class Honours', 'Magna Cum Laude', 'GPA 3.8/4.0') | null",
      "overallGradeValue": "string (numeric value, e.g., '3.8') | null",
      "overallGradeMax": "string (max value, e.g., '4.0') | null",
      "startDate": "YYYY-MM | null",
      "endDate": "YYYY-MM | null",
      "city": "string | null",
      "country": "string (${countries}) | null",
      "isCurrent": "boolean | null",
      "thesisProjectName": "string | null",
      "thesisProjectDescription": "string | null",
      "relevantCoursework": ["string"] | null
    }],
    "professional_experience": [{
      "positionName": "string",
      "position_short": "string (normalized job title for display, max 30 chars - see POSITION NORMALIZATION below)",
      "companyName": "string",
      "company_type": "string (concise industry classification, 2-4 words max - see COMPANY TYPE CLASSIFICATION below)",
      "positionType": "string (${positionTypes}) | null",
      "experienceType": "'industrial' | 'academic' | null",
      "description": "string (brief job description if available) | null",
      "raw_bullet_points": ["string (each bullet point/achievement as-is from CV)"] | null,
      "startDate": "YYYY-MM | null",
      "endDate": "YYYY-MM or 'Present' | null",
      "city": "string | null",
      "country": "string (${countries}) | null",
      "isCurrent": "boolean | null"
    }],
    "technical_skills": [{ "name": "string", "level": "${skillLevels}" }],
    "soft_skills": [{ "name": "string", "level": "${skillLevels}" }],
    "industry_specific_skills": [{ "industry": "string (${industrySkills})", "name": "string", "level": "${skillLevels}" }],
    "base_languages": [{ "language": "string", "proficiency": "${languageProficiencies}" }],
    "certifications": [{
      "name": "string",
      "issuer": "string | null",
      "dateObtained": "YYYY-MM | null",
      "expiryDate": "YYYY-MM | null",
      "credentialId": "string | null",
      "url": "string (verification URL) | null"
    }],
    "professional_interests": ["string"],
    "extracurricular_activities": [{ "organization": "string", "role": "string | null", "achievement": "string | null" }],
    "base_projects": [{
      "projectName": "string",
      "description": "string | null",
      "technologies": ["string"] | null,
      "link": "string (project URL) | null"
    }],
    "working_capacity_percent": "number (0-100) | null",
    "available_from_date": "YYYY-MM-DD | null",
    "desired_duration_months": "string (${durations}) | null",
    "desired_job_types": ["string e.g., (${jobTypes})"],
    "desired_locations": ["string e.g., (${locations})"],
    "desired_industries": ["string e.g., (${industries})"],
    "functional_expertise": ["string - extract from CV, see rule 15"]
  }
  `;

  return `
You are an expert CV data extraction assistant. Your goal is to extract as much structured information as possible from CVs to save users time filling out their profiles. You MUST output ALL extracted text in English. If the CV is in any other language, translate all text fields to English while preserving the exact meaning, structure, and level of detail. Proper nouns (company names, university names, person names, specific certification titles) remain unchanged.

CRITICAL EXTRACTION RULES:

1. **RETURN VALID JSON ONLY** - Your response must be ONLY a valid JSON object matching the structure below.

2. **NO INVENTED DATA** - Only extract information that exists in the CV. Use null for missing data.

3. **EXTRACT RAW BULLET POINTS** - For each job in professional_experience, extract ALL bullet points, achievements, and responsibilities EXACTLY as they appear in the CV. Put each bullet point as a separate string in the "raw_bullet_points" array. Do NOT convert to any specific format - keep them as-is.

4. **URL FORMATTING** - All URLs (linkedinUrl, githubUrl, portfolioUrl, certification URLs, project links) MUST include the full https:// prefix.

5. **PHONE NUMBER SPLITTING** - Split phone numbers into two parts:
   - country_code: International prefix with + (e.g., '+41', '+1', '+49')
   - phoneNumber: Local number only (e.g., '79 123 45 67')

6. **DATE STANDARDIZATION** - All dates must be in YYYY-MM format (e.g., '2020-01', '2023-06'). Use 'Present' for current positions.

7. **DROPDOWN VALUE MAPPING** - For fields with predefined options (country, degreeType, positionType, skill levels, etc.), you MUST map the CV text to the CLOSEST matching option from the provided list. If no confident match exists, use null.

8. **ADDRESS EXTRACTION** - Extract full address details into the contact_address object (street, city, state, country, zip).

9. **CERTIFICATIONS** - Extract all professional certifications, licenses, and credentials with as much detail as available.

10. **PROJECTS** - Extract personal projects, portfolio projects, or significant academic projects with technologies used.

11. **SKILLS CLASSIFICATION** - Classify skills appropriately:
    - technical_skills: Programming languages, frameworks, tools, software
    - soft_skills: Communication, leadership, problem-solving, teamwork
    - industry_specific_skills: Domain-specific expertise (e.g., "Finance: Financial Modeling")

12. **EDUCATION DETAILS** - Extract grades, GPA, class rank, thesis information, and relevant coursework when available.

13. **JOB PREFERENCES** - If the CV mentions career goals, desired roles, preferred locations, or availability, extract this into the desired_* fields.

14. **BOOLEAN FIELDS** - Set isCurrent to true for ongoing education or current positions.

15. **FUNCTIONAL EXPERTISE EXTRACTION** - Use a two-step approach for functional expertise (for commodities/energy/finance talent):

    **Step 1 - Check for explicit mentions:** First, look for explicitly stated expertise in sections like:
    - "Core Competencies:", "Expertise:", "Areas of Expertise:", "Key Skills:", "Functional Skills:"
    - Skills summaries or executive summaries that explicitly list expertise areas

    **Step 2 - Intelligent inference (if not explicit):** If expertise is NOT specifically stated, intelligently determine it from context:
    - Analyze job titles (e.g., "Risk Analyst" → Risk Management, "Trading Desk Lead" → Trading + Leadership)
    - Analyze responsibilities and achievements
    - Consider education background for technical expertise
    - Example: "Managed VaR models and credit exposure analysis" → Risk Management
    - Example: "Built real-time pricing engine in Python" → Technology + Engineering
    - Example: "Led team of 15 traders" → Leadership + Trading
    - Example: "Structured commodity derivatives" → Trading + Quantitative Analysis

    **Valid categories (select ONLY from this list):**
    Trading, Risk Management, Quantitative Analysis, Technology, Operations, Finance, Leadership, Legal, Compliance, Research, Analytics, Engineering

    Return 1-8 categories maximum. Prioritize most relevant based on career focus and seniority.

16. **COMPANY TYPE CLASSIFICATION** - For each job in professional_experience, classify the company into a concise industry category (2-4 words max).

    **Classification Guidelines:**
    - Use the most commonly recognized industry term for the company type
    - Be specific but not overly granular (e.g., "Trading House" not "Commodity Trading Company")
    - For well-known companies, use standard industry classifications
    - For less-known companies, classify based on the company's primary business activity and industry sector

    **Common Classifications (examples, not exhaustive):**
    - "Investment Bank" (Goldman Sachs, Morgan Stanley, JP Morgan)
    - "Major Bank" (UBS, Credit Suisse, Deutsche Bank, HSBC)
    - "Trading House" (Trafigura, Vitol, Glencore, Gunvor, Mercuria)
    - "Oil & Gas Major" (Shell, BP, TotalEnergies, ExxonMobil)
    - "Utility" (Axpo, Alpiq, E.ON, RWE, Engie)
    - "Mining Company" (BHP, Rio Tinto, Vale)
    - "Asset Manager" (BlackRock, Vanguard, PIMCO)
    - "Hedge Fund" (Citadel, Bridgewater, Two Sigma)
    - "Private Equity" (KKR, Blackstone, Carlyle)
    - "Big 4 / Accounting" (Deloitte, PwC, KPMG, EY)
    - "Tech Company" (Google, Microsoft, Meta)
    - "Renewable Energy" (Ørsted, Vestas, First Solar)

    **Consultancy - BE SPECIFIC (avoid generic "Consulting"):**
    - "Management Consultancy" (Accenture, McKinsey, BCG, Bain, Roland Berger, Oliver Wyman)
    - "Strategy Consultancy" (McKinsey, BCG, Bain - for pure strategy roles)
    - "Tech Consultancy" (Accenture, Capgemini, Infosys, Wipro, TCS - for tech-focused roles)

    **Academic/Research - BE SPECIFIC (avoid generic "Academic"):**
    - "University" (ETH Zurich, MIT, Stanford, Oxford, any university)
    - "Research Institute" (Max Planck, Fraunhofer, CERN)
    - "Think Tank" (Brookings, RAND)

    **Important:** You are NOT limited to these categories - classify dynamically based on your knowledge of the company. But AVOID generic terms like "Consulting" or "Academic" - always use more specific classifications.

17. **POSITION NORMALIZATION** - For each job, create a normalized short title for display (max 30 characters).

    **Normalization Rules:**
    1. Remove company-specific levels (III, L5, Grade 2, Band 7)
    2. Use standard abbreviations: Senior → Sr., Junior → Jr., Vice President → VP, Managing Director → MD
    3. Remove redundant words: "of", "for", "the", "and", "in" where possible
    4. Keep the core role identity clear
    5. Max 30 characters - truncate intelligently if needed

    **Examples:**
    - "Senior Vice President of Global Risk Management" → "SVP Risk Management"
    - "Software Engineer III" → "Sr. Software Engineer"
    - "Junior Python Backend Developer" → "Jr. Backend Developer"
    - "Associate Director, Trading Operations" → "Assoc. Director Trading"
    - "Head of Quantitative Research and Development" → "Head of Quant Research"
    - "L5 Software Development Engineer" → "Sr. Software Engineer"
    - "Managing Director - Commodities Trading" → "MD Commodities Trading"

    **Keep these unchanged** (already short/standard):
    - Analyst, Associate, Trader, Developer, Engineer, Manager, Director, VP, SVP, MD, Partner

    **Student/Extracurricular roles - simplify:**
    - "Co-organizer Online Contest" → "Event Organizer"
    - "President of Student Association" → "Student President"
    - "Vice President of Finance Club" → "VP Finance Club"
    - "Teaching Assistant" → "Teaching Assistant" (keep as-is)
    - "Research Assistant" → "Research Assistant" (keep as-is)

EXPECTED JSON OUTPUT STRUCTURE:
${jsonStructure}

CV TEXT TO PARSE:
---
${cvText}
---

Remember: ALL text in the output MUST be in English. Translate any non-English text while keeping the exact meaning and detail intact.

Extract the data now and return ONLY the JSON object.
  `;
}

// Create focused second-pass prompt for ambiguous fields
function createFocusedPrompt(fieldName, cvText, options) {
  if (!fieldName || !cvText || !Array.isArray(options)) {
    return null;
  }

  const prompts = {
    years_of_experience: `
Analyze this CV and determine the total years of professional work experience (exclude education, internships unless specified as full-time).

Return ONLY a JSON object: {"years_of_experience": "value"}

Where value must be EXACTLY one of: ${options.join(', ')}

CV Text:
---
${cvText}
---
    `,
    degreeType: `
Identify the HIGHEST degree mentioned in this CV.

Return ONLY a JSON object: {"degreeType": "value"}

Where value must be EXACTLY one of: ${options.join(', ')}

CV Text:
---
${cvText}
---
    `,
  };

  return prompts[fieldName] || null;
}

// ==========================================
// PROFILE BIO GENERATION
// ==========================================

/**
 * Removes known company names from generated text.
 * Safety net in case GPT includes company names despite instructions.
 * @param {string} text - The generated bio text
 * @param {Array} professionalExperience - Array of experience objects with companyName
 * @returns {string} - Sanitized text with company names replaced
 */
function sanitizeCompanyNames(text, professionalExperience) {
  if (!text || !Array.isArray(professionalExperience)) {
    return text;
  }

  let sanitized = text;

  const companyNames = professionalExperience
    .map(exp => exp.companyName)
    .filter(name => name && name.trim().length > 2)
    .filter((name, index, arr) =>
      arr.findIndex(n => n.toLowerCase() === name.toLowerCase()) === index
    );

  // Longest first to avoid partial replacements
  companyNames.sort((a, b) => b.length - a.length);

  for (const company of companyNames) {
    const escaped = company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
    sanitized = sanitized.replace(regex, 'a previous employer');
  }

  return sanitized;
}

/**
 * Generates a professional profile summary for a candidate using GPT.
 * @param {object} extractedData - The parsed candidate data
 * @returns {Promise<string|null>} - Generated bio or null on failure
 */
async function generateProfileBio(extractedData) {
  const systemPrompt = `
    You are a Senior Executive Search Consultant at "SetSelect," a prestigious boutique recruitment firm in Zurich, Switzerland.
    Your specialty is the Commodities, Energy, and Trading sectors.

    Your Task:
    Write a concise, high-impact professional profile summary (3-4 sentences max) for a candidate based on the provided JSON data.

    Tone & Style:
    - Professional, objective, and impressive.
    - Third-person perspective (e.g., "An experienced...", "This professional...").
    - ANONYMOUS: Do not use names, gendered pronouns (he/she), or specific company names. Use "they," "the candidate," or "this professional." Refer to employers generically (e.g., "a major trading house," "a leading commodities firm," "a global energy company").
    - Swiss Context: Be precise about work permits and locations.

    Structure:
    1. Opening: Seniority + Role.
    2. The "Hook": Integrate any highlight/achievement seamlessly.
    3. Skills: Mention top 3 functional expertise or technical skills.
    4. Closing: Availability and key strengths.
  `;

  const userPrompt = `
    Please generate the profile summary for this candidate:

    ${JSON.stringify(extractedData, null, 2)}

    Note:
    - Expand Canton codes (e.g., 'ZG' -> 'Zug', 'ZH' -> 'Zurich', 'TI' -> 'Ticino').
    - If there is a 'highlight' field with a quote, paraphrase it into a professional achievement statement.
    - Salary should NOT be mentioned in the bio.
    - Do not mention years of experience (already displayed separately).
    - Do not mention languages the candidate speaks (already displayed separately).
    - Keep it to 3-4 sentences maximum.
  `;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini', // Cost-efficient for short summaries
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: 200,
    });

    const rawBio = response.choices[0]?.message?.content?.trim() || null;
    return rawBio ? sanitizeCompanyNames(rawBio, extractedData.professional_experience) : null;
  } catch (error) {
    console.error('[generateProfileBio] Error:', error.message);
    return null; // Graceful degradation
  }
}

// ==========================================
// SHORT SUMMARY GENERATION (2 sentences)
// ==========================================

/**
 * Generates a 2-sentence short summary for candidate cards.
 * @param {object} extractedData - The parsed candidate data
 * @returns {Promise<string|null>} - Generated summary or null on failure
 */
async function generateShortSummary(extractedData) {
  const systemPrompt = `
You are an executive recruiter writing ultra-short candidate summaries for card displays.

Rules:
- EXACTLY 3 sentences
- Each sentence MUST be under 12 words
- No names, no company names, no pronouns
- No years of experience (already shown elsewhere)
- No languages (already shown elsewhere)
- No technical skills or tools (already shown in skills section)
- Punchy, impressive, third-person
- Output plain text only (no quotes, no dashes, no bullet points)

Examples:

Senior software engineer building scalable distributed systems. Track record shipping products to millions of users. Strong technical leadership.

Management consultant advising Fortune 500 on digital transformation. Proven results in cost optimization. Skilled at executive stakeholder management.

Operations director streamlining manufacturing processes across multiple sites. Reduced costs by driving efficiency initiatives. Strong team leadership.

Investment analyst evaluating opportunities in emerging markets. Published research cited by industry leaders. Deep financial modeling expertise.

Product manager launching customer-facing features for fintech platforms. Data-driven decision maker with strong user empathy. Cross-functional collaborator.

Sales executive expanding enterprise accounts in competitive markets. Consistent quota overachievement track record. Skilled relationship builder.

HR business partner driving talent strategy for high-growth organizations. Experience scaling teams through hypergrowth. Strong employer branding background.

Strategy lead developing market entry plans for new geographies. Background in competitive intelligence and pricing. Strong analytical and communication skills.

Supply chain specialist optimizing global logistics and procurement. Track record reducing lead times and costs. Deep vendor management expertise.

Risk professional implementing governance frameworks for regulated industries. Strong compliance and audit background. Experienced in regulatory engagement.
  `;

  const userPrompt = `
Generate a 3-sentence summary (each under 12 words) for:
${JSON.stringify(extractedData, null, 2)}
  `;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.6,
      max_tokens: 80,
    });
    return response.choices[0]?.message?.content?.trim() || null;
  } catch (error) {
    console.error('[generateShortSummary] Error:', error.message);
    return null;
  }
}

// ==========================================
// MAIN PARSING LOGIC WITH TWO-STAGE APPROACH
// ==========================================

async function parseCV(cvText, jobId) {
  if (!cvText || typeof cvText !== 'string') {
    throw new Error('Invalid CV text provided');
  }
  if (!jobId) {
    throw new Error('Job ID is required');
  }

  console.log(`[Job ${jobId}] Starting first-pass comprehensive extraction...`);

  // FIRST PASS: Comprehensive extraction
  const firstPassPrompt = createComprehensiveParsingPrompt(cvText);
  const firstPassCompletion = await openai.chat.completions.create({
    model: OPENAI_MODEL_PARSING,
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: firstPassPrompt }],
    temperature: OPENAI_TEMP_PARSING,
  });

  let extractedData = JSON.parse(firstPassCompletion.choices[0].message.content);
  console.log(`[Job ${jobId}] First pass completed. Fields extracted: ${Object.keys(extractedData).length}`);
  console.log(`[Job ${jobId}] OpenAI returned years_of_experience: "${extractedData.years_of_experience}" (type: ${typeof extractedData.years_of_experience})`);

  // VALIDATION & AUTO-CORRECTION
  console.log(`[Job ${jobId}] Applying validation and auto-correction...`);
  const { corrected, corrections } = validateAndCorrectData(extractedData);
  extractedData = corrected;

  if (corrections.length > 0) {
    console.log(`[Job ${jobId}] Auto-corrections applied: ${corrections.join(', ')}`);
  }

  // FIELD INFERENCE
  console.log(`[Job ${jobId}] Applying field inference logic...`);
  const { inferred, inferences } = applyInferenceLogic(extractedData);
  extractedData = inferred;

  if (inferences.length > 0) {
    console.log(`[Job ${jobId}] Inferences made: ${inferences.join(', ')}`);
  }

  // TWO-STAGE PARSING for critical ambiguous fields (if enabled)
  // Note: years_of_experience is handled by inference logic, not two-pass parsing
  if (ENABLE_TWO_PASS) {
    const uncertainFields = [];

    // Reserved for future critical fields that need focused extraction
    // (years_of_experience is calculated from work history, not extracted)

    if (uncertainFields.length > 0) {
      console.log(`[Job ${jobId}] Second-pass parsing for uncertain fields: ${uncertainFields.map(f => f.field).join(', ')}`);

      for (const { field, options } of uncertainFields) {
        const focusedPrompt = createFocusedPrompt(field, cvText, options);
        if (focusedPrompt) {
          try {
            const refinedCompletion = await openai.chat.completions.create({
              model: OPENAI_MODEL_PARSING,
              response_format: { type: "json_object" },
              messages: [{ role: "user", content: focusedPrompt }],
              temperature: OPENAI_TEMP_PARSING,
            });

            const refinedData = JSON.parse(refinedCompletion.choices[0].message.content);
            if (refinedData[field]) {
              extractedData[field] = refinedData[field];
              console.log(`[Job ${jobId}] Second-pass refined ${field}: ${refinedData[field]}`);
            }
          } catch (error) {
            console.error(`[Job ${jobId}] Second-pass failed for ${field}:`, error.message);
          }
        }
      }
    }
  }

  // Log final extraction summary
  const educationCount = extractedData.education_history?.length || 0;
  const experienceCount = extractedData.professional_experience?.length || 0;
  const skillsCount = (extractedData.technical_skills?.length || 0) + (extractedData.soft_skills?.length || 0);
  const certsCount = extractedData.certifications?.length || 0;
  const expertiseCount = extractedData.functional_expertise?.length || 0;

  console.log(`[Job ${jobId}] Extraction complete: ${educationCount} education, ${experienceCount} experience, ${skillsCount} skills, ${certsCount} certifications, ${expertiseCount} expertise areas`);
  if (expertiseCount > 0) {
    console.log(`[Job ${jobId}] Functional expertise: ${JSON.stringify(extractedData.functional_expertise)}`);
  }

  return extractedData;
}

// ==========================================
// API ENDPOINTS
// ==========================================

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'cv-parser-service', version: '2.2.0' });
});

// Main parsing endpoint
app.post('/api/v1/parse', (req, res, next) => {
  const providedKey = req.headers['x-internal-api-key'];
  if (!INTERNAL_API_KEY || providedKey !== INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}, async (req, res) => {
  const { jobId, storagePath } = req.body;

  if (!jobId || !storagePath) {
    return res.status(400).json({ error: 'jobId and storagePath are required.' });
  }

  // Immediately respond with 202 Accepted
  res.status(202).json({ message: 'Parsing job accepted.' });

  // Process asynchronously
  try {
    await supabase.from('cv_parsing_jobs').update({ status: 'processing' }).eq('id', jobId);

    // Fetch profile_id from cv_parsing_jobs record
    const { data: jobRecord, error: jobFetchError } = await supabase
      .from('cv_parsing_jobs')
      .select('profile_id')
      .eq('id', jobId)
      .single();

    if (jobFetchError || !jobRecord) {
      throw new Error(`Failed to fetch job record: ${jobFetchError?.message || 'Job not found'}`);
    }

    // For SetSelect: Extract userId from storagePath for profile picture
    // Path format: {profileId}/cv.{ext}
    const match = storagePath.match(/^([^\/]+)\//);
    const userId = match ? match[1] : 'unknown';
    const isQuickCV = false; // SetSelect doesn't use quick CV mode

    // Extract text and profile picture in parallel
    const [cvText, profilePicturePath] = await Promise.all([
      convertFileToText(storagePath),
      (async () => {
        try {
          return await extractProfilePicture(storagePath, userId, isQuickCV);
        } catch (pictureError) {
          // Graceful degradation - don't fail parsing if picture extraction fails
          console.error(`[Job ${jobId}] Profile picture extraction failed:`, pictureError.message);
          return null;
        }
      })()
    ]);

    const extractedData = await parseCV(cvText, jobId);

    // Add profile picture path to extracted data
    if (profilePicturePath) {
      extractedData.profile_picture_storage_path = profilePicturePath;
    }

    // Generate professional profile bio
    console.log(`[Job ${jobId}] Generating professional bio...`);
    const profileBio = await generateProfileBio(extractedData);
    if (profileBio) {
      extractedData.profile_bio = profileBio;
      console.log(`[Job ${jobId}] Bio generated: ${profileBio.substring(0, 50)}...`);
    } else {
      console.log(`[Job ${jobId}] Bio generation skipped or failed`);
    }

    // Generate short summary for card display
    console.log(`[Job ${jobId}] Generating short summary...`);
    const shortSummary = await generateShortSummary(extractedData);
    if (shortSummary) {
      extractedData.short_summary = shortSummary;
      console.log(`[Job ${jobId}] Short summary generated: ${shortSummary.substring(0, 50)}...`);
    } else {
      console.log(`[Job ${jobId}] Short summary generation skipped or failed`);
    }

    // Update job status to completed with extracted data
    const { error: updateError } = await supabase.from('cv_parsing_jobs').update({
      status: 'completed',
      extracted_data: extractedData,
      completed_at: new Date().toISOString()
    }).eq('id', jobId);

    if (updateError) {
      console.error(`[Job ${jobId}] Failed to update job status:`, updateError.message);
      throw new Error(`Database update failed: ${updateError.message}`);
    }

    // Update user_profiles with parsed data
    const profileUpdateData = {};

    if (extractedData.profile_bio) {
      profileUpdateData.profile_bio = extractedData.profile_bio;
    }
    if (extractedData.short_summary) {
      profileUpdateData.short_summary = extractedData.short_summary;
    }

    // For functional_expertise: merge user selections with parser-extracted expertise
    // User selections are the source of truth
    if (extractedData.functional_expertise && extractedData.functional_expertise.length > 0) {
      // Fetch user's existing expertise selections from profile
      const { data: existingProfile, error: fetchError } = await supabase
        .from('user_profiles')
        .select('functional_expertise')
        .eq('id', jobRecord.profile_id)
        .single();

      if (!fetchError && existingProfile) {
        const userExpertise = existingProfile.functional_expertise || [];
        const parserExpertise = extractedData.functional_expertise;

        // Merge: user selections first (source of truth), parser supplements
        const mergedExpertise = mergeFunctionalExpertise(userExpertise, parserExpertise);

        console.log(`[Job ${jobId}] Functional expertise merge:`);
        console.log(`  - User selected: ${JSON.stringify(userExpertise)}`);
        console.log(`  - Parser found: ${JSON.stringify(parserExpertise)}`);
        console.log(`  - Merged result: ${JSON.stringify(mergedExpertise)}`);

        if (mergedExpertise.length > 0) {
          profileUpdateData.functional_expertise = mergedExpertise;
        }
      } else {
        // No existing profile or error - just use parser expertise
        const validParserExpertise = validateFunctionalExpertise(extractedData.functional_expertise);
        if (validParserExpertise.length > 0) {
          profileUpdateData.functional_expertise = validParserExpertise;
        }
      }
    }

    if (extractedData.education_history) {
      profileUpdateData.education_history = extractedData.education_history;
    }
    if (extractedData.professional_experience) {
      profileUpdateData.professional_experience = extractedData.professional_experience;
    }
    if (extractedData.technical_skills) {
      profileUpdateData.technical_skills = extractedData.technical_skills;
    }

    if (Object.keys(profileUpdateData).length > 0) {
      const { error: profileUpdateError } = await supabase
        .from('user_profiles')
        .update(profileUpdateData)
        .eq('id', jobRecord.profile_id);

      if (profileUpdateError) {
        console.error(`[Job ${jobId}] Failed to update user profile:`, profileUpdateError.message);
        // Non-fatal - parsing still succeeded, just profile update failed
      } else {
        console.log(`[Job ${jobId}] User profile updated with ${Object.keys(profileUpdateData).length} parsed fields`);
      }

      // Also update talent_profiles (display-only, PII-free)
      const displayData = { ...profileUpdateData };

      // Strip companyName from professional_experience entries
      if (displayData.professional_experience && Array.isArray(displayData.professional_experience)) {
        displayData.professional_experience = displayData.professional_experience.map(entry => {
          const { companyName, ...rest } = entry;
          return rest;
        });
      }

      const { error: displayUpdateError } = await supabase
        .from('talent_profiles')
        .update(displayData)
        .eq('profile_id', jobRecord.profile_id);

      if (displayUpdateError) {
        console.error(`[Job ${jobId}] Failed to update talent_profiles:`, displayUpdateError.message);
        // Non-fatal
      } else {
        console.log(`[Job ${jobId}] talent_profiles updated with ${Object.keys(displayData).length} display fields`);
      }
    }

    console.log(`[Job ${jobId}] CV parsing completed successfully`);

  } catch (error) {
    console.error(`[Job ${jobId}] CV parsing failed:`, error.message);
    await supabase.from('cv_parsing_jobs').update({
      status: 'failed',
      error_message: error.message,
      completed_at: new Date().toISOString()
    }).eq('id', jobId);
  }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`======================================`);
  console.log(`CV Parser Service v2.2.0`);
  console.log(`Listening on port ${PORT}`);
  console.log(`Two-pass parsing: ${ENABLE_TWO_PASS ? 'ENABLED' : 'DISABLED'}`);
  console.log(`Field inference: ${ENABLE_INFERENCE ? 'ENABLED' : 'DISABLED'}`);
  console.log(`Profile picture extraction: ${ENABLE_PROFILE_PICTURE_EXTRACTION ? 'ENABLED' : 'DISABLED'}`);
  if (ENABLE_PROFILE_PICTURE_EXTRACTION) {
    console.log(`  - Vision API timeout: ${VISION_API_TIMEOUT_MS}ms`);
    console.log(`  - Min confidence: ${MIN_CONFIDENCE_THRESHOLD}%`);
  }
  console.log(`Functional expertise extraction: ENABLED`);
  console.log(`  - Categories: ${FUNCTIONAL_EXPERTISE_OPTIONS.length}`);
  console.log(`  - Max merged: 8`);
  console.log(`======================================`);
});
