import express from 'express';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
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
  YEARS_OF_EXPERIENCE_OPTIONS,
  LANGUAGE_PROFICIENCY_OPTIONS,
  SKILL_PROFICIENCY_OPTIONS,
  INDUSTRY_SKILL_OPTIONS,
  DURATION_OPTIONS,
  JOB_TYPE_OPTIONS,
  LOCATION_OPTIONS,
  INDUSTRY_PREFERENCE_OPTIONS,
} from './formOptions.js';

// ==========================================
// INITIALIZATION
// ==========================================
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3002;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
const CONFIDENCE_THRESHOLD = parseFloat(process.env.CONFIDENCE_THRESHOLD) || 70;
const ENABLE_TWO_PASS = process.env.ENABLE_TWO_PASS !== 'false'; // Default true
const ENABLE_INFERENCE = process.env.ENABLE_INFERENCE !== 'false'; // Default true
const ENABLE_PROFILE_PICTURE_EXTRACTION = process.env.ENABLE_PROFILE_PICTURE_EXTRACTION !== 'false'; // Default true
const VISION_API_TIMEOUT_MS = parseInt(process.env.VISION_API_TIMEOUT_MS) || 10000; // 10 seconds
const MIN_CONFIDENCE_THRESHOLD = parseInt(process.env.MIN_CONFIDENCE_THRESHOLD) || 60; // 60%

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
  console.log(`[convertFileToText] Attempting to download from raw-cvs bucket: ${storagePath}`);
  console.log(`[convertFileToText] Supabase URL: ${process.env.SUPABASE_URL ? 'SET' : 'NOT SET'}`);
  console.log(`[convertFileToText] Service Role Key: ${process.env.SUPABASE_SERVICE_ROLE_KEY ? 'SET (length: ' + process.env.SUPABASE_SERVICE_ROLE_KEY.length + ')' : 'NOT SET'}`);

  const { data, error } = await supabase.storage.from('raw-cvs').download(storagePath);

  if (error) {
    console.error(`[convertFileToText] Supabase download error:`, {
      message: error.message,
      statusCode: error.statusCode,
      error: error.error,
      storagePath,
    });
    throw new Error(`Supabase download error: ${error.message} (Status: ${error.statusCode || 'unknown'})`);
  }

  console.log(`[convertFileToText] File downloaded successfully, size: ${data.size} bytes`);

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

    // Only process first 2 pages (profile pictures are typically on page 1)
    const pagesToProcess = Math.min(pages.length, 2);

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

          // Filter out small images (likely icons/logos) - must be at least 100x100px
          if (!width || !height || width < 100 || height < 100) continue;

          // Get image data
          const imageData = xObject?.contents;
          if (!imageData) continue;

          // Convert to Buffer and optimize with sharp
          const imageBuffer = Buffer.from(imageData);
          const optimizedImage = await sharp(imageBuffer)
            .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 85 })
            .toBuffer();

          const metadata = await sharp(optimizedImage).metadata();

          extractedImages.push({
            buffer: optimizedImage,
            width: metadata.width,
            height: metadata.height,
            page: pageIndex + 1
          });
        } catch (err) {
          // Skip individual image extraction errors
          console.warn(`[extractImagesFromPdf] Failed to extract image from page ${pageIndex + 1}:`, err.message);
        }
      }
    }

    return extractedImages;
  } catch (error) {
    console.error('[extractImagesFromPdf] Error:', error);
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
          if (metadata.width < 100 || metadata.height < 100) {
            return { src: '' }; // Skip small images
          }

          // Optimize image
          const optimizedImage = await sharp(imageBuffer)
            .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 85 })
            .toBuffer();

          const optimizedMetadata = await sharp(optimizedImage).metadata();

          extractedImages.push({
            buffer: optimizedImage,
            width: optimizedMetadata.width,
            height: optimizedMetadata.height
          });

          return { src: '' }; // We don't need the HTML, just extracting images
        } catch (err) {
          console.warn('[extractImagesFromDocx] Failed to process image:', err.message);
          return { src: '' };
        }
      })
    });

    return extractedImages;
  } catch (error) {
    console.error('[extractImagesFromDocx] Error:', error);
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
    // Convert first 5 candidate images to base64 (to limit API cost)
    const candidateImages = images.slice(0, 5);
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
        model: 'gpt-4o-mini', // Using gpt-4o-mini for cost efficiency with vision
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              ...imageContent
            ]
          }
        ],
        max_tokens: 200,
        temperature: 0.3,
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
        console.warn('[identifyProfilePicture] Could not parse JSON from response:', content);
        return { imageIndex: null, confidence: 0, reason: 'Failed to parse Vision API response' };
      }

      const result = JSON.parse(jsonMatch[0]);

      // Convert 1-based index to 0-based, validate
      const imageIndex = result.hasProfilePicture && result.imageIndex
        ? result.imageIndex - 1
        : null;

      // Validate index is within bounds
      if (imageIndex !== null && (imageIndex < 0 || imageIndex >= images.length)) {
        console.warn('[identifyProfilePicture] Invalid imageIndex:', result.imageIndex);
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
        console.error('[identifyProfilePicture] Vision API timeout');
        return { imageIndex: null, confidence: 0, reason: 'Vision API timeout' };
      }
      throw apiError;
    }

  } catch (error) {
    console.error('[identifyProfilePicture] Error:', error);
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
      console.error('[uploadProfilePictureToStorage] Upload error:', error);
      return null;
    }

    console.log(`[uploadProfilePictureToStorage] Successfully uploaded to: ${storagePath}`);
    return storagePath;

  } catch (error) {
    console.error('[uploadProfilePictureToStorage] Error:', error);
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
    console.log('[extractProfilePicture] Feature disabled via ENABLE_PROFILE_PICTURE_EXTRACTION');
    return null;
  }

  const startTime = Date.now();
  console.log(`[extractProfilePicture] Starting extraction for: ${storagePath}`);

  try {
    // Download file from storage
    const { data, error } = await supabase.storage.from('raw-cvs').download(storagePath);

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
      console.warn('[extractProfilePicture] Unsupported file type');
      return null;
    }

    console.log(`[extractProfilePicture] Found ${extractedImages.length} candidate images`);

    if (extractedImages.length === 0) {
      console.log('[extractProfilePicture] No images found in CV');
      return null;
    }

    // Use AI to identify the best profile picture
    const identification = await identifyProfilePicture(extractedImages);

    console.log(`[extractProfilePicture] Vision API result:`, {
      imageIndex: identification.imageIndex,
      confidence: identification.confidence,
      reason: identification.reason
    });

    // Check if confidence meets threshold
    if (identification.imageIndex === null || identification.confidence < MIN_CONFIDENCE_THRESHOLD) {
      console.log(`[extractProfilePicture] No suitable profile picture found (confidence: ${identification.confidence}%)`);
      return null;
    }

    // Get the identified image
    const selectedImage = extractedImages[identification.imageIndex];

    // Upload to storage
    const uploadedPath = await uploadProfilePictureToStorage(selectedImage.buffer, userId, isQuickCV);

    const elapsedTime = Date.now() - startTime;
    console.log(`[extractProfilePicture] Completed in ${elapsedTime}ms, uploaded to: ${uploadedPath}`);

    return uploadedPath;

  } catch (error) {
    const elapsedTime = Date.now() - startTime;
    console.error(`[extractProfilePicture] Error after ${elapsedTime}ms:`, error);
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
  if (!trimmed || trimmed === 'present') return trimmed;

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

  // Validate years of experience
  if (corrected.years_of_experience) {
    corrected.years_of_experience = fuzzyMatchToOptions(
      corrected.years_of_experience,
      YEARS_OF_EXPERIENCE_OPTIONS
    );
  }

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
function calculateTotalWorkMonths(experiences) {
  if (!Array.isArray(experiences) || experiences.length === 0) return 0;

  let totalMonths = 0;

  for (const exp of experiences) {
    const start = exp.startDate;
    const end = exp.endDate || 'present';

    if (!start) continue;

    try {
      const startDate = new Date(start + '-01');
      const endDate = end.toLowerCase() === 'present'
        ? new Date()
        : new Date(end + '-01');

      const months = (endDate.getFullYear() - startDate.getFullYear()) * 12
                    + (endDate.getMonth() - startDate.getMonth());

      totalMonths += Math.max(0, months);
    } catch (e) {
      // Skip if dates are invalid
      continue;
    }
  }

  return totalMonths;
}

// Map total months to years of experience range
function mapMonthsToExperienceRange(months) {
  if (months === 0) return 'no-experience';
  if (months < 12) return 'less-than-1';
  const years = Math.floor(months / 12);
  if (years <= 2) return '1-2';
  if (years <= 5) return '3-5';
  if (years <= 10) return '6-10';
  if (years <= 15) return '11-15';
  if (years <= 20) return '16-20';
  return 'more-than-20';
}

// Infer years of experience if missing or uncertain
function inferYearsOfExperience(extractedData) {
  if (extractedData.years_of_experience) {
    return extractedData.years_of_experience; // Already has value
  }

  if (!extractedData.professional_experience || extractedData.professional_experience.length === 0) {
    return 'no-experience';
  }

  const totalMonths = calculateTotalWorkMonths(extractedData.professional_experience);
  return mapMonthsToExperienceRange(totalMonths);
}

// Extract unique countries from experience/education
function extractUniqueCountries(items) {
  if (!Array.isArray(items)) return [];
  const countries = items
    .map(item => item.country)
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

  // Infer years of experience
  if (!inferred.years_of_experience && ENABLE_INFERENCE) {
    inferred.years_of_experience = inferYearsOfExperience(inferred);
    if (inferred.years_of_experience !== 'no-experience') {
      inferences.push(`Inferred years_of_experience: ${inferred.years_of_experience}`);
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
// OPENAI PARSING PROMPTS
// ==========================================

// Create comprehensive first-pass parsing prompt
function createComprehensiveParsingPrompt(cvText) {
  // Dynamically generate all possible option strings
  const countries = getOptionsString(COUNTRY_OPTIONS);
  const generalFields = getOptionsString(GENERAL_FIELD_OPTIONS);
  const specificFields = getOptionsString(SPECIFIC_FIELD_OPTIONS);
  const degreeTypes = getOptionsString(DEGREE_TYPE_OPTIONS);
  const positionTypes = getOptionsString(POSITION_TYPE_OPTIONS);
  const experienceLevels = getOptionsString(YEARS_OF_EXPERIENCE_OPTIONS);
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
    "years_of_experience": "string (${experienceLevels}) | null",
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
      "companyName": "string",
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
    "desired_industries": ["string e.g., (${industries})"]
  }
  `;

  return `
You are an expert CV data extraction assistant. Your goal is to extract as much structured information as possible from CVs to save users time filling out their profiles.

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

EXPECTED JSON OUTPUT STRUCTURE:
${jsonStructure}

CV TEXT TO PARSE:
---
${cvText}
---

Extract the data now and return ONLY the JSON object.
  `;
}

// Create focused second-pass prompt for ambiguous fields
function createFocusedPrompt(fieldName, cvText, options) {
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
// MAIN PARSING LOGIC WITH TWO-STAGE APPROACH
// ==========================================

async function parseCV(cvText, jobId) {
  console.log(`[Job ${jobId}] Starting first-pass comprehensive extraction...`);

  // FIRST PASS: Comprehensive extraction
  const firstPassPrompt = createComprehensiveParsingPrompt(cvText);
  const firstPassCompletion = await openai.chat.completions.create({
    model: "gpt-4o",
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: firstPassPrompt }],
    temperature: 0.1,
  });

  let extractedData = JSON.parse(firstPassCompletion.choices[0].message.content);
  console.log(`[Job ${jobId}] First pass completed. Fields extracted: ${Object.keys(extractedData).length}`);

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
  if (ENABLE_TWO_PASS) {
    const uncertainFields = [];

    // Check if critical fields are missing or potentially uncertain
    if (!extractedData.years_of_experience) {
      uncertainFields.push({
        field: 'years_of_experience',
        options: YEARS_OF_EXPERIENCE_OPTIONS.map(opt => opt.value)
      });
    }

    if (uncertainFields.length > 0) {
      console.log(`[Job ${jobId}] Second-pass parsing for uncertain fields: ${uncertainFields.map(f => f.field).join(', ')}`);

      for (const { field, options } of uncertainFields) {
        const focusedPrompt = createFocusedPrompt(field, cvText, options);
        if (focusedPrompt) {
          try {
            const refinedCompletion = await openai.chat.completions.create({
              model: "gpt-4o",
              response_format: { type: "json_object" },
              messages: [{ role: "user", content: focusedPrompt }],
              temperature: 0.1,
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

  console.log(`[Job ${jobId}] Extraction complete: ${educationCount} education, ${experienceCount} experience, ${skillsCount} skills, ${certsCount} certifications`);

  return extractedData;
}

// ==========================================
// API ENDPOINTS
// ==========================================

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'cv-parser-service', version: '2.1.0' });
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

    // Fetch job record to determine user context
    const { data: jobRecord, error: jobFetchError } = await supabase
      .from('cv_parsing_jobs')
      .select('clerk_user_id, is_quick')
      .eq('id', jobId)
      .single();

    if (jobFetchError) {
      console.warn(`[Job ${jobId}] Could not fetch job record for picture extraction:`, jobFetchError);
    }

    // Extract text and profile picture in parallel
    const [cvText, profilePicturePath] = await Promise.all([
      convertFileToText(storagePath),
      (async () => {
        try {
          // Determine userId for picture storage
          let userId;
          let isQuickCV = false;

          if (jobRecord) {
            isQuickCV = jobRecord.is_quick === true;
            if (isQuickCV) {
              // For Quick CV, extract sessionId from storagePath
              // Path format: quick-uploads/{sessionId}/{filename}
              const match = storagePath.match(/quick-uploads\/([^\/]+)\//);
              userId = match ? match[1] : 'anonymous';
            } else {
              // For Profile CV, use clerk_user_id
              userId = jobRecord.clerk_user_id || 'unknown';
            }
          } else {
            // Fallback: try to extract from path
            const match = storagePath.match(/^([^\/]+)\//);
            userId = match ? match[1] : 'unknown';
          }

          console.log(`[Job ${jobId}] Extracting profile picture (userId: ${userId}, isQuickCV: ${isQuickCV})`);
          return await extractProfilePicture(storagePath, userId, isQuickCV);
        } catch (pictureError) {
          // Graceful degradation - don't fail parsing if picture extraction fails
          console.error(`[Job ${jobId}] Profile picture extraction failed:`, pictureError);
          return null;
        }
      })()
    ]);

    console.log(`[Job ${jobId}] CV text extracted: ${cvText.length} characters`);
    if (profilePicturePath) {
      console.log(`[Job ${jobId}] Profile picture extracted: ${profilePicturePath}`);
    } else {
      console.log(`[Job ${jobId}] No profile picture extracted`);
    }

    const extractedData = await parseCV(cvText, jobId);

    // Add profile picture path to extracted data
    if (profilePicturePath) {
      extractedData.profile_picture_storage_path = profilePicturePath;
    }

    await supabase.from('cv_parsing_jobs').update({
      status: 'completed',
      extracted_data: extractedData,
      completed_at: new Date().toISOString()
    }).eq('id', jobId);

    console.log(`[Job ${jobId}] ✓ CV parsing completed successfully.`);
    console.log(`[Job ${jobId}] → Database trigger will now sync data to user_profiles (profile_id: ${profileId})`);
    console.log(`[Job ${jobId}] → Fields to sync: education, experience, skills, languages, certifications, projects, contact details, profile picture`);

  } catch (error) {
    console.error(`[Job ${jobId}] ✗ CV parsing failed:`, error);
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
  console.log(`CV Parser Service v2.1.0`);
  console.log(`Listening on port ${PORT}`);
  console.log(`Two-pass parsing: ${ENABLE_TWO_PASS ? 'ENABLED' : 'DISABLED'}`);
  console.log(`Field inference: ${ENABLE_INFERENCE ? 'ENABLED' : 'DISABLED'}`);
  console.log(`Confidence threshold: ${CONFIDENCE_THRESHOLD}%`);
  console.log(`Profile picture extraction: ${ENABLE_PROFILE_PICTURE_EXTRACTION ? 'ENABLED' : 'DISABLED'}`);
  if (ENABLE_PROFILE_PICTURE_EXTRACTION) {
    console.log(`  - Vision API timeout: ${VISION_API_TIMEOUT_MS}ms`);
    console.log(`  - Min confidence: ${MIN_CONFIDENCE_THRESHOLD}%`);
  }
  console.log(`======================================`);
});
