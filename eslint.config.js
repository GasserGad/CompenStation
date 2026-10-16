import js from "@eslint/js";
import security from "eslint-plugin-security";
import globals from "globals";

export default [
  { ignores: ["node_modules/", "coverage/", "public/fonts/", "public/img/", "public/icons/"] },
  js.configs.recommended,
  security.configs.recommended,
  {
    files: ["src/**/*.js", "scripts/**/*.js", "test/**/*.js", "*.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: globals.node },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      eqeqeq: ["error", "smart"],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
    },
  },
  {
    files: ["public/**/*.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: globals.browser },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      // Block the DOM APIs that cause XSS; build elements with textContent instead.
      "no-restricted-properties": [
        "error",
        { property: "innerHTML", message: "Use textContent to avoid XSS." },
        { property: "outerHTML", message: "Use textContent to avoid XSS." },
        { property: "insertAdjacentHTML", message: "Use textContent to avoid XSS." },
        { object: "document", property: "write", message: "Not allowed." },
      ],
    },
  },
  {
    files: ["test/**/*.js"],
    rules: { "security/detect-non-literal-regexp": "off", "security/detect-object-injection": "off" },
  },
];
