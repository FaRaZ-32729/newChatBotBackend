const { fromPath } = require('pdf2pic');
const path = require('path');
const fs = require('fs');

const processPDFImages = async (pdfPath, chatbotName, pdfName) => {
    try {
        const outputDir = path.join(__dirname, '../uploads/chatbots', chatbotName, pdfName, 'images');
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const converter = fromPath(pdfPath, {
            density: 300,
            saveFilename: `page`,
            savePath: outputDir,
            format: "png",
            width: 1200,
            height: 1600
        });

        const images = await converter.bulk(-1); // All pages

        return images.map((img, index) => ({
            imageName: img.name,
            imageUrl: `/uploads/chatbots/${chatbotName}/${pdfName}/images/${img.name}`,
            pageNumber: index + 1,
            extractedAt: new Date()
        }));

    } catch (error) {
        console.error("PDF Image Extraction Error:", error);
        return [];
    }
};

module.exports = { processPDFImages };