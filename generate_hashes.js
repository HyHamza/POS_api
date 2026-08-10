const bcrypt = require('bcryptjs');

const passwords = {
  admin: 'admin123',
  rider1: 'rider123',
  rider2: 'rider456'
};

for (const [key, val] of Object.entries(passwords)) {
  const hash = bcrypt.hashSync(val, 10);
  console.log(`${key}: ${hash}`);
}
