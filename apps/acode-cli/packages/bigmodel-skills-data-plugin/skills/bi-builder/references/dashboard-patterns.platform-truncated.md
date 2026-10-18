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
    <div className="flex items-cen