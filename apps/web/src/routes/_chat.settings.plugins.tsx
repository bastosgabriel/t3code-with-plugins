import { createFileRoute } from "@tanstack/react-router";
import { PluginsSettings } from "../components/plugins/PluginsSettings";
export const Route = createFileRoute("/_chat/settings/plugins")({ component: PluginsSettings });
