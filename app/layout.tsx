import type { Metadata, Viewport } from "next";
import { TooltipProvider } from "@/components/ui/tooltip";
import { fontVariableClassName } from "./fonts";
import { fontBootScript } from "./lib/fonts";
import { AccountSyncMount } from "./components/account-sync-mount";
import { BottomNav } from "./components/bottom-nav";
import { PasskeyEnrollPrompt } from "./components/passkey-enroll-prompt";
import { Toaster } from "./components/toast";
import { ConfirmHost } from "./components/confirm";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lasagna",
  description: "Build beautiful, runnable mini-apps powered by Ollama.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4efe6" },
    { media: "(prefers-color-scheme: dark)", color: "#161412" },
  ],
};

// Runs before React hydrates so the saved theme is applied to <html>
// without a light→dark flash. Falls back to the OS preference. Kept tiny
// and dependency-free since it ships in every page's <head>.
const themeBootScript = `try{var t=localStorage.getItem('artifacts:theme');if(!t){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}if(t==='dark'){document.documentElement.classList.add('dark');}}catch(e){}`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`h-full ${fontVariableClassName}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
        <script dangerouslySetInnerHTML={{ __html: fontBootScript }} />
      </head>
      <body className="h-dvh overflow-hidden overscroll-none bg-background text-foreground antialiased">
        <TooltipProvider delay={120}>
          <AccountSyncMount />
          <div className="flex h-full flex-col">
            <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
            <BottomNav />
          </div>
          <Toaster />
          <ConfirmHost />
          <PasskeyEnrollPrompt />
        </TooltipProvider>
      </body>
    </html>
  );
}
