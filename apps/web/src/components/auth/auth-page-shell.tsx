import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** 认证相关页面共用的版式。纯布局，不含逻辑，因此是 Server Component。 */
export function AuthPageShell({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-svh w-full max-w-md flex-col justify-center p-6">
      <Card>
        <CardHeader>
          {/* 页面标题：mono 20px 600（CardTitle 已是 font-heading + font-semibold） */}
          <CardTitle className="text-xl">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {children}
          {footer !== undefined && <p className="text-muted-foreground text-sm">{footer}</p>}
        </CardContent>
      </Card>
    </main>
  );
}
