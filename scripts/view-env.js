const fs = require('fs');
const path = require('path');
const { decrypt } = require('../env-crypto');

const encPath = path.join(__dirname, '..', '.env.enc');

if (!fs.existsSync(encPath)) {
    console.error('.env.enc file not found! Run "npm run encrypt-env" first.');
    process.exit(1);
}

try {
    const encryptedContent = fs.readFileSync(encPath, 'utf8');
    const decrypted = decrypt(encryptedContent);
    
    if (decrypted) {
        console.log('--- Decrypted Content of .env.enc ---');
        console.log(decrypted);
        console.log('--------------------------------------');
    } else {
        console.error('Failed to decrypt the file. Key might be incorrect.');
    }
} catch (e) {
    console.error('Error reading/decrypting file:', e);
    process.exit(1);
}
