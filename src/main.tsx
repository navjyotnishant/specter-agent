import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./globals.css";
// Chrome copied verbatim from the approved mockups -- see src/styles/mockup.css
import "./styles/mockup.css";

createRoot(document.getElementById("root")!).render(<App />);
