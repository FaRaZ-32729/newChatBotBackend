// const poppler = require('pdf-poppler');
// const path = require('path');
// const fs = require('fs');

// const processPDFImages = async (pdfPath, chatbotName, pdfName) => {
//     try {
//         const outputDir = path.join(__dirname, '../uploads/chatbots', chatbotName, pdfName, 'images');
//         if (!fs.existsSync(outputDir)) {
//             fs.mkdirSync(outputDir, { recursive: true });
//         }

//         const outputPrefix = path.join(outputDir, 'page');

//         const options = {
//             format: 'png',
//             out_dir: outputDir,
//             out_prefix: 'page',
//             page: null,           // null = all pages
//             scale: 1024,
//             density: 300
//         };

//         await poppler.convert(pdfPath, options);

//         // Read generated files
//         const files = fs.readdirSync(outputDir);
//         const imageFiles = files.filter(file => file.endsWith('.png'));

//         return imageFiles.map((imgName, index) => ({
//             imageName: imgName,
//             imageUrl: `/uploads/chatbots/${chatbotName}/${pdfName}/images/${imgName}`,
//             pageNumber: index + 1,
//             extractedAt: new Date()
//         }));

//     } catch (error) {
//         console.error("PDF Image Extraction Error:", error);
//         return [];
//     }
// };

// module.exports = { processPDFImages };




// const { execFile } = require('child_process');
// const path = require('path');
// const util = require('util');

// const execFileAsync = util.promisify(execFile);

// /**
//  * Pick the right python command for the current OS.
//  * - Override anytime by setting PYTHON_BIN in your .env (e.g. PYTHON_BIN=py)
//  * - Windows commonly only has "python" (not "python3") on PATH
//  * - "py" is the official Windows launcher and is the most reliable fallback
//  */
// const PYTHON_BIN = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');

// /**
//  * Extracts ONLY the truly embedded images from a PDF (via PyMuPDF),
//  * each tagged with the nearby heading/caption text so you know what
//  * the image is about.
//  *
//  * @param {string} pdfPath      - path to the uploaded PDF on disk
//  * @param {string} chatbotName  - sanitized chatbot folder name
//  * @param {string} pdfName      - sanitized pdf name (used as subfolder)
//  * @returns {Promise<Array>}    - array of extracted image metadata
//  */
// const processPDFImages = async (pdfPath, chatbotName, pdfName) => {
//     const outputDir = path.join(__dirname, '../uploads/chatbots', chatbotName, pdfName, 'images');
//     const scriptPath = path.join(__dirname, 'extract_images.py');

//     try {
//         const { stdout, stderr } = await execFileAsync(PYTHON_BIN, [scriptPath, pdfPath, outputDir], {
//             maxBuffer: 1024 * 1024 * 20 // 20MB, in case a PDF has lots of images
//         });

//         if (stderr) {
//             console.error("extract_images.py stderr:", stderr);
//         }

//         const rawResults = JSON.parse(stdout);

//         if (rawResults.error) {
//             console.error("PDF Image Extraction Error:", rawResults.error);
//             return [];
//         }

//         const extractedImages = rawResults.map(item => ({
//             imageName: item.imageName,
//             imageUrl: `/uploads/chatbots/${chatbotName}/${pdfName}/images/${item.imageName}`,
//             pageNumber: item.pageNumber,
//             heading: item.heading,        // text found just above the image
//             caption: item.caption,        // text found just below the image
//             contextText: item.contextText, // heading + caption combined (use for search/embeddings)
//             extractedAt: new Date()
//         }));

//         return extractedImages;

//     } catch (error) {
//         console.error("PDF Embedded Image Extraction Error:", error);
//         return [];
//     }
// };

// module.exports = { processPDFImages };

const { execFile } = require('child_process');
const path = require('path');
const util = require('util');

const execFileAsync = util.promisify(execFile);

/**
 * Pick the right python command for the current OS.
 * - Override anytime by setting PYTHON_BIN in your .env (e.g. PYTHON_BIN=py)
 * - Windows commonly only has "python" (not "python3") on PATH
 * - "py" is the official Windows launcher and is the most reliable fallback
 */
const PYTHON_BIN = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');

/**
 * Extracts ONLY the truly embedded images from a PDF (via PyMuPDF),
 * each tagged with the nearby heading/caption text so you know what
 * the image is about.
 *
 * @param {string} pdfPath      - path to the uploaded PDF on disk
 * @param {string} chatbotName  - sanitized chatbot folder name
 * @param {string} pdfName      - sanitized pdf name (used as subfolder)
 * @returns {Promise<Array>}    - array of extracted image metadata
 */
const processPDFImages = async (pdfPath, chatbotName, pdfName) => {
    const outputDir = path.join(__dirname, '../uploads/chatbots', chatbotName, pdfName, 'images');
    const scriptPath = path.join(__dirname, 'extract_images.py');

    try {
        const { stdout, stderr } = await execFileAsync(PYTHON_BIN, [scriptPath, pdfPath, outputDir], {
            maxBuffer: 1024 * 1024 * 20 // 20MB, in case a PDF has lots of images
        });

        if (stderr) {
            console.error("extract_images.py stderr:", stderr);
        }

        const rawResults = JSON.parse(stdout);

        if (rawResults.error) {
            console.error("PDF Image Extraction Error:", rawResults.error);
            return [];
        }

        const extractedImages = rawResults.map(item => ({
            imageName: item.imageName,
            imageUrl: `/uploads/chatbots/${chatbotName}/${pdfName}/images/${item.imageName}`,
            pageNumber: item.pageNumber,
            mainHeading: item.mainHeading,       // e.g. "Polekit" (document title)
            sectionHeading: item.sectionHeading, // e.g. "Features"
            subHeading: item.subHeading,         // e.g. "Installation"
            contextText: item.contextText,       // combined text used for the filename/context
            headingSource: item.headingSource,   // "toc" (bookmarks) or "font-size" (fallback)
            extractedAt: new Date()
        }));

        return extractedImages;

    } catch (error) {
        console.error("PDF Embedded Image Extraction Error:", error);
        return [];
    }
};

module.exports = { processPDFImages };