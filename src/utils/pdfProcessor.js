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
 * Extracts ONLY the truly embedded images from a PDF (via PyMuPDF).
 * Throws on any failure so chatbot creation can be fully rolled back.
 *
 * @param {string} pdfPath      - path to the uploaded PDF on disk
 * @param {string} chatbotName  - sanitized chatbot folder name
 * @param {string} pdfName      - sanitized pdf name (used as subfolder)
 * @returns {Promise<Array>}    - array of extracted image metadata
 */
const processPDFImages = async (pdfPath, chatbotName, pdfName) => {
    const outputDir = path.join(__dirname, '../../uploads/chatbots', chatbotName, pdfName, 'images');
    const scriptPath = path.join(__dirname, 'extract_images.py');
    const displayName = path.basename(pdfPath);

    let stdout;
    let stderr;

    try {
        ({ stdout, stderr } = await execFileAsync(PYTHON_BIN, [scriptPath, pdfPath, outputDir], {
            maxBuffer: 1024 * 1024 * 20, // 20MB
            encoding: 'utf8',
            env: {
                ...process.env,
                PYTHONIOENCODING: 'utf-8',
                PYTHONUTF8: '1',
            },
        }));
    } catch (error) {
        const detail = error.stderr || error.message || 'Unknown error';
        const isPythonMissing =
            error.code === 'ENOENT' ||
            /not recognized|No such file|cannot find/i.test(String(detail));

        if (isPythonMissing) {
            throw new Error(
                `PDF extraction failed for "${displayName}": Python is not available. Install Python and PyMuPDF (pip install PyMuPDF), or set PYTHON_BIN in .env.`
            );
        }

        throw new Error(`PDF extraction failed for "${displayName}": ${detail}`);
    }

    if (stderr) {
        console.error('extract_images.py stderr:', stderr);
    }

    let rawResults;
    try {
        rawResults = JSON.parse(stdout);
    } catch (error) {
        throw new Error(
            `PDF extraction failed for "${displayName}": invalid response from extraction script.`
        );
    }

    if (rawResults && rawResults.error) {
        throw new Error(`PDF extraction failed for "${displayName}": ${rawResults.error}`);
    }

    if (!Array.isArray(rawResults)) {
        throw new Error(
            `PDF extraction failed for "${displayName}": unexpected extraction result format.`
        );
    }

    return rawResults.map((item) => ({
        imageName: item.imageName,
        imageUrl: `/uploads/chatbots/${chatbotName}/${pdfName}/images/${item.imageName}`,
        pageNumber: item.pageNumber,
        mainHeading: item.mainHeading,
        sectionHeading: item.sectionHeading,
        subHeading: item.subHeading,
        contextText: item.contextText,
        headingSource: item.headingSource,
        extractedAt: new Date()
    }));
};

module.exports = { processPDFImages };
