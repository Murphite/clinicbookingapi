'use strict';

const app = require('./app');
const { migrate } = require('./db');

const port = Number(process.env.PORT || 3000);

migrate()
  .then(() => {
    app.listen(port, () => console.log(`Clinic booking API listening on http://localhost:${port}`));
  })
  .catch((err) => {
    console.error('Failed to initialise database:', err);
    process.exit(1);
  });
