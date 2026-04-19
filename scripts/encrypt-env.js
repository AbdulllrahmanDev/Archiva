const fs = require('fs');
const path = require('path');
const { encrypt } = require('../env-crypto');

const envPath = path.join(__dirname, '..', '.env');
const encPath = path.join(__dirname, '..', '.env.enc');

if (!fs.existsSync(envPath)) {
    console.error('.env file not found!');
    process.exit(1);
}

try {
    const content = fs.readFileSync(envPath, 'utf8');
    const encrypted = encrypt(content);
    
    fs.writeFileSync(encPath, encrypted);
    console.log('Successfully encrypted .env to .env.enc');
    console.log('Important: You can now safely delete the original .env from your distribution build.');
} catch (e) {
    console.error('Encryption failing:', e);
    process.exit(1);
}
