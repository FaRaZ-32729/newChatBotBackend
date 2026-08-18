const SEARCH_KNOWLEDGE_TOOL = {
  functionDeclarations: [
    {
      name: 'searchKnowledgeBase',
      description:
        'Search this chatbot\'s uploaded PDF knowledge for specific facts, numbers, features, or details. Call this BEFORE answering any question that needs document content not already in the short PURPOSE context. Do not guess.',
      parameters: {
        type: 'OBJECT',
        properties: {
          query: {
            type: 'STRING',
            description: 'The visitor question or the specific fact to look up, in the user\'s language.',
          },
          pdfKey: {
            type: 'STRING',
            description: 'Optional topic key (slug of the PDF name) to restrict search to one document.',
          },
        },
        required: ['query'],
      },
    },
  ],
};

module.exports = { SEARCH_KNOWLEDGE_TOOL };
