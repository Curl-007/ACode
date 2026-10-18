> 2026-10-09 修改：仅为展示组件参考，先遵守 ../SKILL.md 的只读、租户和导出范围；英文代码片段不授权读写真实数据。

# Recharts Chart Guide

## Table of Contents

1. [Basic Setup](#basic-setup)
2. [Line Chart](#line-chart)
3. [Bar Chart](#bar-chart)
4. [Pie Chart](#pie-chart)
5. [Area Chart](#area-chart)
6. [Composed Chart](#composed-chart)
7. [Scatter Chart](#scatter-chart)
8. [Radar Chart](#radar-chart)
9. [Funnel Chart](#funnel-chart)
10. [Responsive Container](#responsive-container)
11. [Common Configuration](#common-configuration)

---

## Basic Setup

```tsx
"use client";

import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  AreaChart, Area, ComposedChart, ScatterChart, Scatter,
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  FunnelChart, Funnel, LabelList,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer
} from "recharts";
```

---

## Line Chart

```tsx
const data = [
  { month: "Jan", revenue: 4000, orders: 240 },
  { month: "Feb", revenue: 3000, orders: 198 },
  { month: "Mar", revenue: 5000, orders: 300 },
];

<ResponsiveContainer width="100%" height={300}>
  <LineChart data={data}>
    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
    <XAxis dataKey="month" className="text-sm" />
    <YAxis className="text-sm" />
    <Tooltip
      contentStyle={{ backgroundColor: "hsl(var(--background))", border: "1px solid hsl(var(--border))" }}
    />
    <Legend />
    <Line type="monotone" dataKey="revenue" stroke="hsl(var(--primary))" strokeWidth={2} dot={{ r: 4 }} />
    <Line type="monotone" dataKey="orders" stroke="hsl(var(--secondary))" strokeWidth={2} dot={{ r: 4 }} />
  </LineChart>
</ResponsiveContainer>
```

**Multi-series line chart**: Add separate `<Line>` components for each data series.

---

## Bar Chart

```tsx
const data = [
  { category: "Electronics", sales: 4000, returns: 240 },
  { category: "Clothing", sales: 3000, returns: 139 },
  { category: "Food", sales: 2000, returns: 80 },
];

<ResponsiveContainer width="100%" height={300}>
  <BarChart data={data}>
    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
    <XAxis dataKey="category" className="text-sm" />
    <YAxis className="text-sm" />
    <Tooltip contentStyle={{ backgroundColor: "hsl(var(--background))" }} />
    <Legend />
    <Bar dataKey="sales" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
    <Bar dataKey="returns" fill="hsl(var(--destructive))" radius={[4, 4, 0, 0]} />
  </BarChart>
</ResponsiveContainer>
```

**Stacked bar chart**: Add `stackId="a"` to Bar components in the same group.

**Horizontal bar chart**: Add `layout="vertical"` and swap XAxis/YAxis dataKey.

---

## Pie Chart

```tsx
const data = [
  { name: "Desktop", value: 400, color: "hsl(var(--primary))" },
  { name: "Mobile", value: 300, color: "hsl(var(--secondary))" },
  { name: "Tablet", value: 200, color: "hsl(var(--accent))" },
];

<ResponsiveContainer width="100%" height={300}>
  <PieChart>
    <Pie
      data={data}
      cx="50%"
      cy="50%"
      innerRadius={60}
      outerRadius={100}
      paddingAngle={2}
      dataKey="value"
      label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
    >
      {data.map((entry, index) => (
        <Cell key={`cell-${index}`} fill={entry.color} />
      ))}
    </Pie>
    <Tooltip />
    <Legend />
  </PieChart>
</ResponsiveContainer>
```

**Solid pie chart**: Set `innerRadius={0}`.

**Donut chart**: Set `innerRadius > 0`.

---

## Area Chart

```tsx
const data = [
  { date: "2024-01", users: 1000, sessions: 2400 },
  { date: "2024-02", users: 1200, sessions: 2800 },
  { date: "2024-03", users: 1500, sessions: 3200 },
];

<ResponsiveContainer width="100%" height={300}>
  <AreaChart data={data}>
    <defs>
      <linearGradient id="colorUsers" x1="0" y1="0" x2="0" y2="1">
        <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.8} />
        <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0.1} />
      </linearGradient>
    </defs>
    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
    <XAxis dataKey="date" className="text-sm" />
    <YAxis className="text-sm" />
    <Tooltip contentStyle={{ backgroundColor: "hsl(var(--background))" }} />
    <Area type="monotone" dataKey="users" stroke="hsl(var(--primary))" fill="url(#colorUsers)" />
  </AreaChart>
</ResponsiveContainer>
```

**Stacked area chart**: Add `stackId="1"` to Area components in the same group.

---

## Composed Chart

```tsx
const data = [
  { month: "Jan", revenue: 4000, orders: 240, growth: 10 },
  { month: "Feb", revenue: 3000, orders: 198, growth: -5 },
  { month: "Mar", revenue: 5000, orders: 300, growth: 25 },
];

<ResponsiveContainer width="100%" height={300}>
  <ComposedChart data={data}>
    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
    <XAxis dataKey="month" className="text-sm" />
    <YAxis yAxisId="left" className="text-sm" />
    <YAxis yAxisId="right" orientation="right" className="text-sm" />
    <Tooltip contentStyle={{ backgroundColor: "hsl(var(--background))" }} />
    <Legend />
    <Bar yAxisId="left" dataKey="revenue" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
    <Line yAxisId="right" type="monotone" dataKey="growth" stroke="hsl(var(--destructive))" />
  </ComposedChart>
</ResponsiveContainer>
```

---

## Scatter Chart

```tsx
const data = [
  { x: 100, y: 200, z: 200 },
  { x: 120, y: 100, z: 260 },
  { x: 170, y: 300, z: 400 },
];

<ResponsiveContainer width="100%" height={300}>
  <ScatterChart>
    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
    <XAxis type="number" dataKey="x" name="Price" className="text-sm" />
    <YAxis type="number" dataKey="y" name="Sales" className="text-sm" />
    <Tooltip cursor={{ strokeDasharray: "3 3" }} />
    <Scatter name="Products" data={data} fill="hsl(var(--primary))">
      {data.map((entry, index) => (
        <Cell key={`cell-${index}`} fill={`hsl(${index * 30}, 70%, 50%)`} />
      ))}
    </Scatter>
  </ScatterChart>
</ResponsiveContainer>
```

---

## Radar Chart

```tsx
const data = [
  { subject: "Performance", A: 120, B: 110 },
  { subject: "Reliability", A: 98, B: 130 },
  { subject: "Usability", A: 86, B: 130 },
  { subject: "Features", A: 99, B: 100 },
  { subject: "Support", A: 85, B: 90 },
];

<ResponsiveContainer width="100%" height={300}>
  <RadarChart data={data}>
    <PolarGrid className="stroke-muted" />
    <PolarAngleAxis dataKey="subject" className="text-sm" />
    <PolarRadiusAxis angle={30} domain={[0, 150]} />
    <Radar name="Product A" dataKey="A" stroke="hsl(var(--primary))" fill="hsl(var(--primary))" fillOpacity={0.5} />
    <Radar name="Product B" dataKey="B" stroke="hsl(var(--secondary))" fill="hsl(var(--secondary))" fillOpacity={0.5} />
    <Legend />
    <Tooltip />
  </RadarChart>
</ResponsiveContainer>
```

---

## Funnel Chart

```tsx
const data = [
  { name: "Visit", value: 5000, fill: "hsl(var(--primary))" },
  { name: "Signup", value: 3000, fill: "hsl(var(--secondary))" },
  { name: "Purchase", value: 1500, fill: "hsl(var(--accent))" },
  { name: "Repeat", value: 800, fill: "hsl(var(--destructive))" },
];

<ResponsiveContainer width="100%" height={300}>
  <FunnelChart>
    <Tooltip />
    <Funnel dataKey="value" data={data} isAnimationActive>
      <LabelList position="right" fill="#000" stroke="none" dataKey="name" />
    </Funnel>
  </FunnelChart>
</ResponsiveContainer>
```

---

## Responsive Container

**Must** wrap charts with `ResponsiveContainer` for responsive behavior:

```tsx
<ResponsiveContainer width="100%" height={300}>
  {/* Chart component */}
</ResponsiveContainer>
```

Note: Parent container must have explicit width/height, otherwise the chart won't render.

---

## Common Configuration

### Color Scheme

Use shadcn/ui CSS variables for theme consistency:

```tsx
const COLORS = {
  primary: "hsl(var(--primary))",
  secondary: "hsl(var(--secondary))",
  accent: "hsl(var(--accent))",
  destructive: "hsl(var(--destructive))",
  muted: "hsl(var(--muted))",
};

// Multi-series colors
const CHART_COLORS = [
  "hsl(221, 83%, 53%)",  // blue
  "hsl(142, 71%, 45%)",  // green
  "hsl(38, 92%, 50%)",   // amber
  "hsl(0, 84%, 60%)",    // red
  "hsl(262, 83%, 58%)",  // purple
  "hsl(199, 89%, 48%)",  // cyan
];
```

### Formatting Functions

```tsx
// Number formatting
const formatNumber = (value: number) =>
  new Intl.NumberFormat("en-US").format(value);

// Currency formatting
const formatCurrency = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);

// Percentage formatting
const formatPercent = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "percent", minimumFractionDigits: 1 }).format(value);

// Date formatting
const formatDate = (date: string) =>
  new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric" });
```

### Custom Tooltip

```tsx
const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-background border rounded-lg p-3 shadow-lg">
      <p className="font-medium">{label}</p>
      {payload.map((entry: any, index: number) => (
        <p key={index} style={{ color: entry.color }}>
          {entry.name}: {formatNumber(entry.value)}
        </p>
      ))}
    </div>
  );
};

<Tooltip content={<CustomTooltip />} />
```

### Custom Legend

```tsx
const CustomLegend = ({ payload }: any) => (
  <div className="flex gap-4 justify-center mt-4">
    {payload.map((entry: any, index: number) => (
      <div key={index} className="flex items-center gap-2">
        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: entry.color }} />
        <span className="text-sm text-muted-foreground">{entry.value}</span>
      </div>
    ))}
  </div>
);

<Legend content={<CustomLegend />} />
```
