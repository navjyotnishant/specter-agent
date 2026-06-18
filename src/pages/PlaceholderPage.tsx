import type { LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export function PlaceholderPage({
  title,
  description,
  icon: Icon,
  items,
}: {
  title: string;
  description: string;
  icon: LucideIcon;
  items: string[];
}) {
  return (
    <div className="space-y-6">
      <Card className="overflow-hidden rounded-[2rem] border-white/80 bg-white/85 shadow-sm backdrop-blur-xl">
        <CardContent className="p-6 sm:p-8">
          <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
            <div>
              <Badge className="mb-4 rounded-full bg-indigo-100 px-4 py-1.5 text-indigo-800 hover:bg-indigo-100">MVP workspace</Badge>
              <h2 className="text-3xl font-black tracking-tight text-slate-950 sm:text-4xl">{title}</h2>
              <p className="mt-3 max-w-3xl text-slate-600">{description}</p>
            </div>
            <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-3xl bg-indigo-600 text-white shadow-xl shadow-indigo-100">
              <Icon className="h-10 w-10" />
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {items.map((item) => (
          <Card key={item} className="rounded-3xl border-white/80 bg-white/75">
            <CardContent className="p-5">
              <div className="mb-4 h-2 w-16 rounded-full bg-cyan-300" />
              <h3 className="font-black text-slate-950">{item}</h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">Configured for local-first operation with auditable SQLite persistence.</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
