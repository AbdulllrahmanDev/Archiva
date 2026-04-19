const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// This key is used for obfuscation. 
const SECRET_KEY = 'archiva-secret-v1-encryption-key-32ch'; 
const ALGORITHM = 'aes-256-cbc';

// Ensure key is exactly 32 bytes for AES-256
const KEY = crypto.createHash('sha256').update(String(SECRET_KEY)).digest();

/**
 * Encrypts a string
 * @param {string} text 
 * @returns {string} iv:encryptedData
 */
function encrypt(text) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

/**
 * Decrypts a string
 * @param {string} encryptedData iv:encryptedData
 * @returns {string}
 */
function decrypt(encryptedData) {
    try {
        const parts = encryptedData.split(':');
        if (parts.length !== 2) return null;
        
        const iv = Buffer.from(parts.shift(), 'hex');
        const encryptedText = Buffer.from(parts.join(':'), 'hex');
        const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (e) {
        console.error('Decryption failed:', e.message);
        return null;
    }
}

/**
 * Loads and decrypts .env.enc into process.env
 * @param {string} filePath 
 */
function loadEncryptedEnv(filePath) {
    if (!fs.existsSync(filePath)) {
        return false;
    }

    try {
        const encryptedContent = fs.readFileSync(filePath, 'utf8');
        const decryptedContent = decrypt(encryptedContent);
        
        if (!decryptedContent) return false;

        const lines = decryptedContent.split(/\r?\n/);
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            
            const [key, ...valueParts] = trimmed.split('=');
            if (key) {
                const value = valueParts.join('=').replace(/(^['"]|['"]$)/g, '');
                process.env[key.trim()] = value;
            }
        }
        return true;
    } catch (e) {
        console.error('Error loading encrypted env:', e);
        return false;
    }
}

module.exports = {
    encrypt,
    decrypt,
    loadEncryptedEnv
};
