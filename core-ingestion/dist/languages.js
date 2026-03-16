export var SupportedLanguages;
(function (SupportedLanguages) {
    SupportedLanguages["JavaScript"] = "javascript";
    SupportedLanguages["TypeScript"] = "typescript";
    SupportedLanguages["Python"] = "python";
    SupportedLanguages["Java"] = "java";
    SupportedLanguages["C"] = "c";
    SupportedLanguages["CPlusPlus"] = "cpp";
    SupportedLanguages["CSharp"] = "csharp";
    SupportedLanguages["Go"] = "go";
    SupportedLanguages["Ruby"] = "ruby";
    SupportedLanguages["Rust"] = "rust";
    SupportedLanguages["PHP"] = "php";
    SupportedLanguages["Kotlin"] = "kotlin";
    SupportedLanguages["Swift"] = "swift";
    SupportedLanguages["Scala"] = "scala";
})(SupportedLanguages || (SupportedLanguages = {}));
const EXT_MAP = {
    '.ts': SupportedLanguages.TypeScript,
    '.tsx': SupportedLanguages.TypeScript,
    '.js': SupportedLanguages.JavaScript,
    '.jsx': SupportedLanguages.JavaScript,
    '.mjs': SupportedLanguages.JavaScript,
    '.cjs': SupportedLanguages.JavaScript,
    '.py': SupportedLanguages.Python,
    '.java': SupportedLanguages.Java,
    '.c': SupportedLanguages.C,
    '.h': SupportedLanguages.C,
    '.cpp': SupportedLanguages.CPlusPlus,
    '.cc': SupportedLanguages.CPlusPlus,
    '.cxx': SupportedLanguages.CPlusPlus,
    '.hpp': SupportedLanguages.CPlusPlus,
    '.cs': SupportedLanguages.CSharp,
    '.go': SupportedLanguages.Go,
    '.rb': SupportedLanguages.Ruby,
    '.rs': SupportedLanguages.Rust,
    '.php': SupportedLanguages.PHP,
    '.kt': SupportedLanguages.Kotlin,
    '.kts': SupportedLanguages.Kotlin,
    '.swift': SupportedLanguages.Swift,
    '.scala': SupportedLanguages.Scala,
    '.sc': SupportedLanguages.Scala,
};
export function languageFromPath(filePath) {
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    return EXT_MAP[ext] ?? null;
}
