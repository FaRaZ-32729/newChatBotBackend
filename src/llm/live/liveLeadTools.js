const SUBMIT_LEAD_TOOL = {
  functionDeclarations: [
    {
      name: 'submitLead',
      description:
        'Save confirmed lead data (Name, Company Name, Designation, Phone, Email) to MongoDB after the user confirms accuracy.',
      parameters: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING', description: 'Lead full name' },
          company: { type: 'STRING', description: 'Lead company name' },
          designation: { type: 'STRING', description: 'Lead designation or job title' },
          phone: {
            type: 'STRING',
            description:
              "One or more phone numbers. If multiple, separate with a comma, e.g. '03001234567, 03009876543'.",
          },
          email: {
            type: 'STRING',
            description:
              "One or more email addresses. If multiple, separate with a comma, e.g. 'a@x.com, b@y.com'.",
          },
        },
        required: ['name', 'phone', 'email'],
      },
    },
  ],
};

module.exports = { SUBMIT_LEAD_TOOL };
