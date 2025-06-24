#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const translationsDir = path.join(__dirname, "translations");

function getNestedKeys(obj, prefix = "") {
	const keys = [];
	
	for (const [key, value] of Object.entries(obj)) {
		const fullKey = prefix ? `${prefix}.${key}` : key;
		
		if (typeof value === "object" && value !== null && !Array.isArray(value)) {
			keys.push(...getNestedKeys(value, fullKey));
		} else {
			keys.push(fullKey);
		}
	}
	
	return keys;
}

function validateTranslation(baseKeys, translationKeys) {
	const missingKeys = baseKeys.filter(key => !translationKeys.includes(key));
	const extraKeys = translationKeys.filter(key => !baseKeys.includes(key));
	
	return {
		isValid: missingKeys.length === 0 && extraKeys.length === 0,
		missingKeys,
		extraKeys
	};
}

function main() {
	const languages = fs.readdirSync(translationsDir)
		.filter(file => file.endsWith(".json"))
		.map(file => path.basename(file, ".json"));
	const results = {};
	
	// Load English as the reference
	const enPath = path.join(translationsDir, "en.json");
	if (!fs.existsSync(enPath)) {
		console.error("❌ English translation file not found");
		process.exit(1);
	}
	
	const enTranslations = JSON.parse(fs.readFileSync(enPath, "utf-8"));
	const baseKeys = getNestedKeys(enTranslations);
	
	console.log(`📋 Found ${baseKeys.length} translation keys in English base`);
	console.log("");
	
	// Validate each language
	for (const lang of languages) {
		if (lang === "en") continue; // Skip the base language
		
		const langPath = path.join(translationsDir, `${lang}.json`);
		if (!fs.existsSync(langPath)) {
			console.log(`⚠️  ${lang.toUpperCase()}: Translation file not found`);
			continue;
		}
		
		const translations = JSON.parse(fs.readFileSync(langPath, "utf-8"));
		const translationKeys = getNestedKeys(translations);
		
		const result = validateTranslation(baseKeys, translationKeys);
		results[lang] = result;
		
		if (result.isValid) {
			console.log(`✅ ${lang.toUpperCase()}: All translation keys present`);
		} else {
			console.log(`❌ ${lang.toUpperCase()}: Missing or extra keys found`);
			
			if (result.missingKeys.length > 0) {
				console.log(`  Missing keys (${result.missingKeys.length}):`);
				result.missingKeys.forEach(key => console.log(`    - ${key}`));
			}
			
			if (result.extraKeys.length > 0) {
				console.log(`  Extra keys (${result.extraKeys.length}):`);
				result.extraKeys.forEach(key => console.log(`    + ${key}`));
			}
		}
		console.log("");
	}
	
	// Summary
	const allValid = Object.values(results).every(result => result.isValid);
	
	if (allValid) {
		console.log("🎉 All translations are valid!");
		process.exit(0);
	} else {
		console.log("💥 Some translations have issues. Please fix them before proceeding.");
		process.exit(1);
	}
}

main();