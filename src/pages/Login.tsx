import { Lock } from "lucide-react";
import { PlaceholderPage } from "./PlaceholderPage";

export default function Login() {
  return <PlaceholderPage title="Local account login" description="Multi-user local authentication shell for admin and operator accounts." icon={Lock} items={["Email/password login", "Session check", "Admin role", "Logout flow"]} />;
}
