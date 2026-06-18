import { KeyRound } from "lucide-react";
import { PlaceholderPage } from "./PlaceholderPage";

export default function Setup() {
  return <PlaceholderPage title="Bootstrap setup" description="Create the first local admin user, verify SQLite volume health, and prepare model/provider configuration." icon={KeyRound} items={["First admin account", "SQLite volume check", "Local secrets directory", "Runtime safety defaults"]} />;
}
