import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "TechView Remarketing",
  description:
    "Gestão de recuperação de carrinhos com controle e rastreabilidade.",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
