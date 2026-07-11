const fs = require('fs');
const path = require('path');

function cleanFile(filePath) {
    if (!filePath.endsWith('.ts') && !filePath.endsWith('.js')) return;
    
    let content = fs.readFileSync(filePath, 'utf8');
    
    // Remove single line comments (//) but KEEP special compiler directives like @ts-ignore, eslint-disable
    content = content.replace(/^[ \t]*\/\/(?!\/| @ts-| eslint-| prettier-).*$/gm, '');
    
    // Clean up empty lines that were left behind
    content = content.replace(/\n\s*\n\s*\n/g, '\n\n');
    
    fs.writeFileSync(filePath, content);
}

function walkDir(dir) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory()) {
            walkDir(fullPath);
        } else {
            cleanFile(fullPath);
        }
    }
}

const targetDir = process.argv[2];
if (targetDir) {
    walkDir(targetDir);
    console.log(`Cleaned comments in ${targetDir}`);
} else {
    console.log("Provide target directory");
}
