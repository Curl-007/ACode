> 2026-10-09 修改：仅为展示组件参考，先遵守 ../SKILL.md 的只读、租户和导出范围；英文代码片段不授权读写真实数据。

# Dashboard Layout Patterns

## Table of Contents

1. [Common BI Layout Patterns](#common-bi-layout-patterns)
2. [Page Structure](#page-structure)
3. [Responsive Grid Layout](#responsive-grid-layout)
4. [KPI Card Component](#kpi-card-component)
5. [Chart Card Container](#chart-card-container)
6. [Filter Bar](#filter-bar)
7. [Complete Page Example](#complete-page-example)

---

## Common BI Layout Patterns

### Layout Selection Guide

| Layout Type | Best For | Key Features |
|-------------|----------|--------------|
| Executive Dashboard | C-level, managers | High-level KPIs, trends, minimal interaction |
| Operational Dashboard | Operations team | Real-time data, alerts, status monitoring |
| Analytical Dashboard | Analysts, data team | Deep filters, drill-down, cross-analysis |
| Comparison Dashboard | Strategy, planning | Period comparison, YoY/MoM, benchmarks |

---

### 1. Executive Dashboard

Best for: Quick overview of business health, decision-making at a glance.

```
┌──────────────────────────────────────────────────────────┐
│  Logo    Dashboard Title              [Date] [Export]    │
├──────────┬──────────┬──────────┬─────────────────────────┤
│  KPI 1   │  KPI 2   │  KPI 3   │  KPI 4                  │
│ Revenue  │ Orders   │  AOV     │ Customers               │
├──────────┴──────────┴──────────┴─────────────────────────┤
│                                                          │
│              Main Trend Chart (LineChart)                │
│                    Full Width                            │
│                                                          │
├─────────────────────────────┬────────────────────────────┤
│                             │                            │
│   Category Distribution     │    Top 10 Rankings         │
│        (PieChart)           │      (BarChart)            │
│                             │                            │
└─────────────────────────────┴────────────────────────────┘
```

**Code Template:**

```tsx
// Executive Dashboard Layout
export function ExecutiveDashboard() {
  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-background sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Logo />
            <h1 className="text-xl font-bold">Executive Dashboard</h1>
          </div>
          <div className="flex items-center gap-2">
            <DateRangePicker />
            <ExportButton />
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 space-y-6">
        {/* KPI Cards - 4 columns */}
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <KPICard title="Total Revenue" value="$1.2M" change={12.5} />
          <KPICard title="Orders" value="8,234" change={8.2} />
          <KPICard title="Avg Order Value" value="$145" change={3.1} />
          <KPICard title="Customers" value="2,345" change={15.3} />
        </section>

        {/* Main Trend - Full Width */}
        <section>
          <ChartCard title="Revenue Trend" description="Last 12 months">
            <RevenueLineChart data={revenueData} height={350} />
          </ChartCard>
        </section>

        {/* Secondary Charts - 2 columns */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <ChartCard title="Category Distribution">
            <CategoryPieChart data={categoryData} />
          </ChartCard>
          <ChartCard title="Top 10 Products">
            <TopProductsBarChart data={productData} />
          </ChartCard>
        </section>
      </main>
    </div>
  );
}
```

---

### 2. Operational Dashboard

Best for: Real-time monitoring, quick response, status tracking.

```
┌──────────────────────────────────────────────────────────┐
│  🟢 System Online    │ 1,234 Active Users │ ⚠️ 3 Alerts  │
├──────────┬──────────┬──────────┬─────────────────────────┤
│ Today's  │ Orders   │ Pending  │ Processing              │
│ Revenue  │ Count    │ Orders   │ Time                    │
│ $45,678  │  234     │   12     │ 2.3 min                 │
├──────────┴──────────┴──────────┴─────────────────────────┤
│                                                          │
│         Real-time Orders Table (auto-refresh)            │
│  ID | Customer | Amount | Status | Time | Actions        │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  ⚠️ Alert: Order #1234 pending > 10 min                  │
│  ⚠️ Alert: Low inventory for Product X                   │
│  ℹ️ Info: Daily target 80% achieved                      │
└──────────────────────────────────────────────────────────┘
```

**Code Template:**

```tsx
// Operational Dashboard Layout
export function OperationalDashboard() {
  return (
    <div className="min-h-screen bg-background">
      {/* Status Bar */}
      <div className="bg-muted border-b">
        <div className="container mx-auto px-4 py-2 flex items-center justify-between text-sm">
          <div className="flex items-center gap-6">
            <StatusIndicator status="online" label="System Online" />
            <span className="text-muted-foreground">
              <Users className="inline h-4 w-4 mr-1" />
              1,234 Active Users
            </span>
          </div>
          <div className="flex items-center gap-2">
            <AlertBadge count={3} />
            <span className="text-muted-foreground">
              Last updated: {new Date().toLocaleTimeString()}
            </span>
          </div>
        </div>
      </div>

      {/* Header */}
      <header className="border-b bg-background">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-xl font-bold">Operations Center</h1>
          <Button variant="outline" size="sm">
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 space-y-6">
        {/* Real-time KPIs */}
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <KPICard
            title="Today's Revenue"
            value="$45,678"
            icon={<DollarSign />}
            live
          />
          <KPICard
            title="Orders"
            value="234"
            icon={<ShoppingCart />}
            live
          />
          <KPICard
            title="Pending"
            value="12"
            variant={12 > 10 ? "warning" : "default"}
            icon={<Clock />}
          />
          <KPICard
            title="Avg Processing"
            value="2.3 min"
            icon={<Timer />}
          />
        </section>

        {/* Live Orders Table */}
        <section>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Live Orders</CardTitle>
              <div className="flex items-center gap-2">
                <Badge variant="outline">
                  <span className="animate-pulse mr-2 h-2 w-2 rounded-full bg-green-500" />
                  Live
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <DataTable
                columns={orderColumns}
                data={orders}
                searchKey="customer"
              />
            </CardContent>
          </Card>
        </section>

        {/* Alerts Section */}
        <section>
          <Card>
            <CardHeader>
              <CardTitle>Alerts & Notifications</CardTitle>
            </CardHeader>
            <CardContent>
              <AlertsList alerts={alerts} />
            </CardContent>
          </Card>
        </section>
      </main>
    </div>
  );
}

// Status Indicator Component
function StatusIndicator({ status, label }: { status: "online" | "offline"; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className={cn(
        "h-2 w-2 rounded-full",
        status === "online" ? "bg-green-500" : "bg-red-500"
      )} />
      <span>{label}</span>
    </div>
  );
}

// Alert Badge Component
function AlertBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <Badge variant="destructive">
      <AlertTriangle className="h-3 w-3 mr-1" />
      {count} Alerts
    </Badge>
  );
}
```

---

### 3. Analytical Dashboard

Best for: Deep data analysis, multi-dimensional filtering, exploration.

```
┌─────────┬────────────────────────────────────────────────┐
│         │  Dashboard Title          [Export] [Share]     │
│ Filters ├────────────┬───────────┬───────────┬───────────┤
│         │   KPI 1    │   KPI 2   │   KPI 3   │   KPI 4   │
│ 📅 Date ├────────────┴───────────┴───────────┴───────────┤
│         │                                                │
│ 📂 Cat  │          Trend Analysis (AreaChart)            │
│         │                                                │
│ 🏷️ Tag  ├────────────────────────┬───────────────────────┤
│         │                        │                       │
│ 📊 Grp  │   Breakdown Chart      │   Comparison Chart    │
│         │                        │                       │
│ [Apply] ├────────────────────────┴───────────────────────┤
│ [Reset] │                                                │
│         │              Detailed DataTable                │
│         │   (with column sorting, filtering, export)     │
│         │                                                │
└─────────┴────────────────────────────────────────────────┘
```

**Code Template:**

```tsx
// Analytical Dashboard Layout
export function AnalyticalDashboard() {
  const [filters, setFilters] = useState<FilterState>(defaultFilters);
  const [isFilterOpen, setIsFilterOpen] = useState(true);

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-background sticky top-0 z-20">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsFilterOpen(!isFilterOpen)}
            >
              <PanelLeftClose className="h-4 w-4" />
            </Button>
            <h1 className="text-xl font-bold">Analytics Dashboard</h1>
          </div>
          <div className="flex items-center gap-2">
            <ExportButton />
            <ShareButton />
          </div>
        </div>
      </header>

      <div className="flex">
        {/* Sidebar Filters */}
        <aside className={cn(
          "w-64 border-r bg-muted/30 p-4 space-y-6 transition-all",
          isFilterOpen ? "block" : "hidden"
        )}>
          <div>
            <h3 className="font-medium mb-3 flex items-center gap-2">
              <Filter className="h-4 w-4" />
              Filters
            </h3>

            {/* Date Range */}
            <div className="space-y-2">
              <Label>Date Range</Label>
              <DateRangePicker
                value={filters.dateRange}
                onChange={(range) => setFilters({ ...filters, dateRange: range })}
              />
            </div>

            {/* Category */}
            <div className="space-y-2 mt-4">
              <Label>Category</Label>
              <MultiSelect
                options={categories}
                value={filters.categories}
                onChange={(cats) => setFilters({ ...filters, categories: cats })}
              />
            </div>

            {/* Status */}
            <div className="space-y-2 mt-4">
              <Label>Status</Label>
              <CheckboxGroup
                options={statuses}
                value={filters.statuses}
                onChange={(sts) => setFilters({ ...filters, statuses: sts })}
              />
            </div>

            {/* Grouping */}
            <div className="space-y-2 mt-4">
              <Label>Group By</Label>
              <Select
                value={filters.groupBy}
                onValueChange={(v) => setFilters({ ...filters, groupBy: v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="day">Day</SelectItem>
                  <SelectItem value="week">Week</SelectItem>
                  <SelectItem value="month">Month</SelectItem>
                  <SelectItem value="category">Category</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Filter Actions */}
          <div className="flex flex-col gap-2">
            <Button onClick={applyFilters}>
              Apply Filters
            </Button>
            <Button variant="outline" onClick={resetFilters}>
              Reset
            </Button>
          </div>

          {/* Active Filters */}
          <div>
            <h4 className="text-sm font-medium mb-2">Active Filters</h4>
            <div className="flex flex-wrap gap-1">
              {activeFilters.map((filter) => (
                <Badge key={filter.id} variant="secondary">
                  {filter.label}
                  <X className="h-3 w-3 ml-1 cursor-pointer" />
                </Badge>
              ))}
            </div>
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 p-6 space-y-6">
          {/* KPI Cards */}
          <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <KPICard title="Total" value="$1.2M" change={12} />
            <KPICard title="Average" value="$145" change={-3} />
            <KPICard title="Count" value="8,234" change={8} />
            <KPICard title="Rate" value="3.2%" change={0.5} />
          </section>

          {/* Main Analysis Chart */}
          <section>
            <ChartCard
              title="Trend Analysis"
              description="Filtered data over time"
              actions={<ChartTypeToggle />}
            >
              <TrendAreaChart data={trendData} height={300} />
            </ChartCard>
          </section>

          {/* Breakdown Charts */}
          <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <ChartCard title="Breakdown by Category">
              <BreakdownBarChart data={breakdownData} />
            </ChartCard>
            <ChartCard title="Comparison">
              <ComparisonChart data={comparisonData} />
            </ChartCard>
          </section>

          {/* Detailed Table */}
          <section>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>Detailed Data</CardTitle>
                <Button variant="outline" size="sm">
                  <Download className="h-4 w-4 mr-2" />
                  Export CSV
                </Button>
              </CardHeader>
              <CardContent>
                <DataTable
                  columns={analyticsColumns}
                  data={tableData}
                  searchKey="name"
                  enableColumnFilters
                  enableSorting
                />
              </CardContent>
            </Card>
          </section>
        </main>
      </div>
    </div>
  );
}
```

---

### 4. Comparison Dashboard

Best for: Period-over-period analysis, benchmarking, goal tracking.

```
┌──────────────────────────────────────────────────────────┐
│  Dashboard Title     [This Period ▼] vs [Last Period ▼] │
├──────────────────────────────────────────────────────────┤
│  ┌─────────────────────┐  ┌─────────────────────────┐   │
│  │ This Period         │  │ Last Period             │   │
│  │ $1,234,567 (+12.5%) │  │ $1,097,838              │   │
│  │ Revenue             │  │ Revenue                 │   │
│  └─────────────────────┘  └─────────────────────────┘   │
├──────────────────────────────────────────────────────────┤
│                                                          │
│           Comparison Trend (Dual Line Chart)             │
│        ━━━ This Period    ┄┄┄ Last Period                │
│                                                          │
├─────────────────────────────┬────────────────────────────┤
│  This Period Top 10         │  Last Period Top 10        │
│  1. Product A  $50,000      │  1. Product B  $45,000     │
│  2. Product B  $45,000      │  2. Product A  $42,000     │
│  3. Product C  $40,000      │  3. Product C  $38,000     │
├─────────────────────────────┴────────────────────────────┤
│                                                          │
│              Change Analysis (Waterfall/Bar)             │
│     What contributed to the +12.5% growth?               │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

**Code Template:**

```tsx
// Comparison Dashboard Layout
export function ComparisonDashboard() {
  const [currentPeriod, setCurrentPeriod] = useState("this-month");
  const [comparePeriod, setComparePeriod] = useState("last-month");

  return (
    <div className="min-h-screen bg-background">
      {/* Header with Period Selectors */}
      <header className="border-b bg-background sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <h1 className="text-xl font-bold">Comparison Dashboard</h1>
            <div className="flex items-center gap-2">
              <Select value={currentPeriod} onValueChange={setCurrentPeriod}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="this-month">This Month</SelectItem>
                  <SelectItem value="this-quarter">This Quarter</SelectItem>
                  <SelectItem value="this-year">This Year</SelectItem>
                </SelectContent>
              </Select>
              <span className="text-muted-foreground">vs</span>
              <Select value={comparePeriod} onValueChange={setComparePeriod}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="last-month">Last Month</SelectItem>
                  <SelectItem value="last-quarter">Last Quarter</SelectItem>
                  <SelectItem value="last-year">Last Year</SelectItem>
                  <SelectItem value="same-period-ly">Same Period LY</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 space-y-6">
        {/* Comparison KPI Cards */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ComparisonKPICard
            title="Revenue"
            currentValue="$1,234,567"
            previousValue="$1,097,838"
            change={12.5}
            currentLabel="This Month"
            previousLabel="Last Month"
          />
          <ComparisonKPICard
            title="Orders"
            currentValue="8,234"
            previousValue="7,521"
            change={9.5}
            currentLabel="This Month"
            previousLabel="Last Month"
          />
        </section>

        {/* Trend Comparison Chart */}
        <section>
          <ChartCard
            title="Trend Comparison"
            description="Daily comparison between periods"
          >
            <ComparisonLineChart
              currentData={currentPeriodData}
              previousData={previousPeriodData}
              height={350}
            />
            <div className="flex justify-center gap-6 mt-4">
              <div className="flex items-center gap-2">
                <div className="w-4 h-0.5 bg-primary" />
                <span className="text-sm">This Period</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-4 h-0.5 bg-muted-foreground border-dashed" />
                <span className="text-sm">Last Period</span>
              </div>
            </div>
          </ChartCard>
        </section>

        {/* Side-by-side Rankings */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card>
            <CardHeader>
              <CardTitle>This Period Top 10</CardTitle>
              <CardDescription>Best performing items</CardDescription>
            </CardHeader>
            <CardContent>
              <RankingList
                data={currentTopItems}
                showChange
                compareData={previousTopItems}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Last Period Top 10</CardTitle>
              <CardDescription>Previous best performers</CardDescription>
            </CardHeader>
            <CardContent>
              <RankingList data={previousTopItems} />
            </CardContent>
          </Card>
        </section>

        {/* Change Analysis */}
        <section>
          <ChartCard
            title="Change Analysis"
            description="What contributed to the change?"
          >
            <WaterfallChart data={changeAnalysis} height={300} />
          </ChartCard>
        </section>
      </main>
    </div>
  );
}

// Comparison KPI Card Component
function ComparisonKPICard({
  title,
  currentValue,
  previousValue,
  change,
  currentLabel,
  previousLabel,
}: {
  title: string;
  currentValue: string;
  previousValue: string;
  change: number;
  currentLabel: string;
  previousLabel: string;
}) {
  const isPositive = change >= 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4">
          {/* Current Period */}
          <div className="space-y-1">
            <p className="text-2xl font-bold">{currentValue}</p>
            <p className="text-xs text-muted-foreground">{currentLabel}</p>
          </div>
          {/* Previous Period */}
          <div className="space-y-1">
            <p className="text-2xl font-bold text-muted-foreground">
              {previousValue}
            </p>
            <p className="text-xs text-muted-foreground">{previousLabel}</p>
          </div>
        </div>
        {/* Change Indicator */}
        <div className={cn(
          "mt-4 flex items-center gap-1 text-sm font-medium",
          isPositive ? "text-green-600" : "text-red-600"
        )}>
          {isPositive ? (
            <TrendingUp className="h-4 w-4" />
          ) : (
            <TrendingDown className="h-4 w-4" />
          )}
          <span>{isPositive ? "+" : ""}{change}%</span>
          <span className="text-muted-foreground font-normal">vs {previousLabel}</span>
        </div>
      </CardContent>
    </Card>
  );
}

// Comparison Line Chart Component
function ComparisonLineChart({
  currentData,
  previousData,
  height
}: {
  currentData: { date: string; value: number }[];
  previousData: { date: string; value: number }[];
  height: number;
}) {
  const mergedData = currentData.map((item, index) => ({
    date: item.date,
    current: item.value,
    previous: previousData[index]?.value || 0,
  }));

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={mergedData}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="date" />
        <YAxis />
        <Tooltip />
        <Line
          type="monotone"
          dataKey="current"
          stroke="hsl(var(--primary))"
          strokeWidth={2}
          name="This Period"
        />
        <Line
          type="monotone"
          dataKey="previous"
          stroke="hsl(var(--muted-foreground))"
          strokeWidth={2}
          strokeDasharray="5 5"
          name="Last Period"
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
```

---

### Layout Selection Flowchart

```
                    Who is the primary user?
                            │
           ┌────────────────┼────────────────┐
           ▼                ▼                ▼
      Executives       Operations       Analysts
           │                │                │
           ▼                ▼                ▼
    ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
    │ Executive   │  │ Operational │  │ Analytical  │
    │ Dashboard   │  │ Dashboard   │  │ Dashboard   │
    └─────────────┘  └─────────────┘  └─────────────┘
           │                │                │
           │    Need period comparison?      │
           │          │                      │
           │          ▼                      │
           │   ┌─────────────┐               │
           └──►│ Comparison  │◄──────────────┘
               │ Dashboard   │
               └─────────────┘
```

---

## Page Structure

```
app/
├── dashboard/
│   ├── page.tsx           # Dashboard main page
│   ├── loading.tsx        # Loading state
│   └── components/
│       ├── kpi-cards.tsx
│       ├── revenue-chart.tsx
│       ├── filters.tsx
│       └── export-button.tsx
├── api/
│   └── dashboard/
│       └── route.ts       # Data API
```

---

## Responsive Grid Layout

Use Tailwind CSS Grid for responsive layouts:

```tsx
// Equal 4-column grid (KPI cards)
<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
  {/* KPI cards */}
</div>

// 2-column layout (large chart left, small chart right)
<div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
  <div className="lg:col-span-2">
    {/* Large chart */}
  </div>
  <div>
    {/* Small chart or list */}
  </div>
</div>

// Equal 2-column grid
<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
  {/* Charts */}
</div>

// Full-width section
<div className="w-full">
  {/* Full-width chart or table */}
</div>
```

**Complete Page Layout Template**:

```tsx
export default function DashboardPage() {
  return (
    <div className="min-h-screen bg-background">
      {/* Top navigation */}
      <header className="border-b">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <div className="flex items-center gap-4">
            {/* Filters and action buttons */}
          </div>
        </div>
      </header>

      {/* Main content area */}
      <main className="container mx-auto px-4 py-6 space-y-6">
        {/* KPI cards row */}
        <section>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* KPI cards */}
          </div>
        </section>

        {/* Main chart area */}
        <section>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2">
              {/* Main trend chart */}
            </div>
            <div>
              {/* Distribution or ranking */}
            </div>
          </div>
        </section>

        {/* Detailed analysis area */}
        <section>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Comparison charts */}
          </div>
        </section>

        {/* Data table */}
        <section>
          {/* DataTable */}
        </section>
      </main>
    </div>
  );
}
```

---

## KPI Card Component

```tsx
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowUpIcon, ArrowDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface KPICardProps {
  title: string;
  value: string | number;
  change?: number;
  changeLabel?: string;
  icon?: React.ReactNode;
}

export function KPICard({ title, value, change, changeLabel, icon }: KPICardProps) {
  const isPositive = change && change > 0;
  const isNegative = change && change < 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
        {icon && <div className="text-muted-foreground">{icon}</div>}
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {change !== undefined && (
          <p className={cn(
            "text-xs flex items-center gap-1 mt-1",
            isPositive && "text-green-600",
            isNegative && "text-red-600",
            !isPositive && !isNegative && "text-muted-foreground"
          )}>
            {isPositive && <ArrowUpIcon className="h-3 w-3" />}
            {isNegative && <ArrowDownIcon className="h-3 w-3" />}
            <span>{Math.abs(change)}%</span>
            {changeLabel && <span className="text-muted-foreground">{changeLabel}</span>}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
```

**Usage Example**:

```tsx
import { DollarSign, Users, ShoppingCart, TrendingUp } from "lucide-react";

<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
  <KPICard
    title="Total Revenue"
    value="$1,234,567"
    change={12.5}
    changeLabel="vs last month"
    icon={<DollarSign className="h-4 w-4" />}
  />
  <KPICard
    title="Active Users"
    value="23,456"
    change={8.2}
    changeLabel="vs last month"
    icon={<Users className="h-4 w-4" />}
  />
  <KPICard
    title="Orders"
    value="1,234"
    change={-3.1}
    changeLabel="vs last month"
    icon={<ShoppingCart className="h-4 w-4" />}
  />
  <KPICard
    title="Conversion Rate"
    value="3.2%"
    change={0.5}
    changeLabel="vs last month"
    icon={<TrendingUp className="h-4 w-4" />}
  />
</div>
```

---

## Chart Card Container

```tsx
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface ChartCardProps {
  title: string;
  description?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}

export function ChartCard({ title, description, children, actions, className }: ChartCardProps) {
  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </CardHeader>
      <CardContent>
        {children}
      </CardContent>
    </Card>
  );
}
```

**Usage Example**:

```tsx
<ChartCard
  title="Revenue Trend"
  description="Revenue changes over the last 12 months"
  actions={<ExportButton data={data} filename="revenue" />}
>
  <ResponsiveContainer width="100%" height={300}>
    <LineChart data={data}>
      {/* ... */}
    </LineChart>
  </ResponsiveContainer>
</ChartCard>
```

---

## Filter Bar

```tsx
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CalendarIcon, FilterIcon } from "lucide-react";
import { format } from "date-fns";
import { enUS } from "date-fns/locale";
import { DateRange } from "react-day-picker";

interface FiltersProps {
  onFilterChange: (filters: FilterState) => void;
}

interface FilterState {
  dateRange: DateRange | undefined;
  category: string;
  status: string;
}

export function DashboardFilters({ onFilterChange }: FiltersProps) {
  const [dateRange, setDateRange] = useState<DateRange | undefined>();
  const [category, setCategory] = useState<string>("all");
  const [status, setStatus] = useState<string>("all");

  const handleFilterChange = () => {
    onFilterChange({ dateRange, category, status });
  };

  return (
    <div className="flex flex-wrap items-center gap-4">
      {/* Date range picker */}
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" className="w-[280px] justify-start text-left font-normal">
            <CalendarIcon className="mr-2 h-4 w-4" />
            {dateRange?.from ? (
              dateRange.to ? (
                <>
                  {format(dateRange.from, "yyyy/MM/dd", { locale: enUS })} -{" "}
                  {format(dateRange.to, "yyyy/MM/dd", { locale: enUS })}
                </>
              ) : (
                format(dateRange.from, "yyyy/MM/dd", { locale: enUS })
              )
            ) : (
              <span>Select date range</span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            initialFocus
            mode="range"
            defaultMonth={dateRange?.from}
            selected={dateRange}
            onSelect={setDateRange}
            numberOfMonths={2}
            locale={enUS}
          />
        </PopoverContent>
      </Popover>

      {/* Category selector */}
      <Select value={category} onValueChange={setCategory}>
        <SelectTrigger className="w-[180px]">
          <SelectValue placeholder="Select category" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Categories</SelectItem>
          <SelectItem value="electronics">Electronics</SelectItem>
          <SelectItem value="clothing">Clothing</SelectItem>
          <SelectItem value="food">Food</SelectItem>
        </SelectContent>
      </Select>

      {/* Status selector */}
      <Select value={status} onValueChange={setStatus}>
        <SelectTrigger className="w-[150px]">
          <SelectValue placeholder="Select status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Status</SelectItem>
          <SelectItem value="active">Active</SelectItem>
          <SelectItem value="inactive">Inactive</SelectItem>
        </SelectContent>
      </Select>

      {/* Apply filters button */}
      <Button onClick={handleFilterChange}>
        <FilterIcon className="mr-2 h-4 w-4" />
        Apply Filters
      </Button>
    </div>
  );
}
```

---

## Complete Page Example

```tsx
// app/dashboard/page.tsx
import { Suspense } from "react";
import { KPICards } from "./components/kpi-cards";
import { RevenueChart } from "./components/revenue-chart";
import { CategoryPieChart } from "./components/category-pie";
import { TopProductsTable } from "./components/top-products";
import { DashboardFilters } from "./components/filters";
import { ExportButton } from "./components/export-button";
import { Skeleton } from "@/components/ui/skeleton";

export default function DashboardPage() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b sticky top-0 bg-background z-10">
        <div className="container mx-auto px-4 py-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <h1 className="text-2xl font-bold">Sales Dashboard</h1>
            <div className="flex items-center gap-2">
              <DashboardFilters />
              <ExportButton />
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 space-y-6">
        {/* KPI cards */}
        <Suspense fallback={<KPICardsSkeleton />}>
          <KPICards />
        </Suspense>

        {/* Main chart area */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2">
            <Suspense fallback={<ChartSkeleton />}>
              <RevenueChart />
            </Suspense>
          </div>
          <div>
            <Suspense fallback={<ChartSkeleton />}>
              <CategoryPieChart />
            </Suspense>
          </div>
        </div>

        {/* Detailed data table */}
        <Suspense fallback={<TableSkeleton />}>
          <TopProductsTable />
        </Suspense>
      </main>
    </div>
  );
}

function KPICardsSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-[120px]" />
      ))}
    </div>
  );
}

function ChartSkeleton() {
  return <Skeleton className="h-[400px]" />;
}

function TableSkeleton() {
  return <Skeleton className="h-[300px]" />;
}
```
