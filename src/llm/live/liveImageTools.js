const SET_PRESENTATION_TOPIC_TOOL = {
  functionDeclarations: [
    {
      name: 'setPresentationTopic',
      description:
        'REQUIRED for every product/feature answer (not greetings). '
        + 'Send the PDF topic key that matches the visitor question BEFORE you speak the answer. '
        + 'The backend loads the correct slideshow on screen — you must call this; STT cannot pick images.',
      parameters: {
        type: 'OBJECT',
        properties: {
          pdfKey: {
            type: 'STRING',
            description:
              'Topic key from TOPIC KEYS (e.g. ecosystem_pdf, ac_pdf, easy_solar). '
              + 'Pick based on the visitor question meaning, not garbled STT.',
          },
          imageId: {
            type: 'INTEGER',
            description:
              'Optional catalog image id to show first — choose the id whose title matches your opening point.',
          },
        },
        required: ['pdfKey'],
      },
    },
  ],
};

module.exports = { SET_PRESENTATION_TOPIC_TOOL };
