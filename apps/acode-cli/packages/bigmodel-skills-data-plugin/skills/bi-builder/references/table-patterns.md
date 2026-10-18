> 2026-10-09 修改：仅为展示组件参考，先遵守 ../SKILL.md 的只读、租户和导出范围；英文代码片段不授权读写真实数据。

# DataTable Patterns

Based on shadcn/ui DataTable with TanStack Table for BI dashboards.

## Installation

```bash
# Install TanStack Table
npm install @tanstack/react-table

# Add shadcn/ui table component
npx shadcn@latest add table
```

## Basic DataTable Structure

### 1. Define Columns

```tsx
// components/columns.tsx
"use client";

import { ColumnDef } from "@tanstack/react-table";
import { ArrowUpDown, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Define your data type
export type Order = {
  id: string;
  customer: string;
  email: string;
  amount: number;
  status: "pending" | "processing" | "completed" | "cancelled";
  createdAt: Date;
};

export const columns: ColumnDef<Order>[] = [
  {
    accessorKey: "id",
    header: "Order ID",
  },
  {
    accessorKey: "customer",
    header: ({ column }) => {
      return (
        <Button
          variant="ghost"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Customer
          <ArrowUpDown className="ml-2 h-4 w-4" />
        </Button>
      );
    },
  },
  {
    accessorKey: "email",
    header: "Email",
  },
  {
    accessorKey: "amount",
    header: () => <div className="text-right">Amount</div>,
    cell: ({ row }) => {
      const amount = parseFloat(row.getValue("amount"));
      const formatted = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
      }).format(amount);
      return <div className="text-right font-medium">{formatted}</div>;
    },
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => {
      const status = row.getValue("status") as string;
      return (
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
            status === "completed"
              ? "bg-green-100 text-green-800"
              : status === "pending"
              ? "bg-yellow-100 text-yellow-800"
              : status === "processing"
              ? "bg-blue-100 text-blue-800"
              : "bg-red-100 text-red-800"
          }`}
        >
          {status}
        </span>
      );
    },
  },
  {
    accessorKey: "createdAt",
    header: "Date",
    cell: ({ row }) => {
      return new Date(row.getValue("createdAt")).toLocaleDateString();
    },
  },
  {
    id: "actions",
    cell: ({ row }) => {
      const order = row.original;
      return (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="h-8 w-8 p-0">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => navigator.clipboard.writeText(order.id)}
            >
              Copy ID
            </DropdownMenuItem>
            <DropdownMenuItem>View details</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );
    },
  },
];
```

### 2. Create DataTable Component

```tsx
// components/data-table.tsx
"use client";

import {
  ColumnDef,
  ColumnFiltersState,
  SortingState,
  VisibilityState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useState } from "react";

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  searchKey?: string;
  searchPlaceholder?: string;
}

export function DataTable<TData, TValue>({
  columns,
  data,
  searchKey,
  searchPlaceholder = "Search...",
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [rowSelection, setRowSelection] = useState({});

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    state: {
      sorting,
      columnFilters,
      columnVisibility,
      rowSelection,
    },
  });

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        {searchKey && (
          <Input
            placeholder={searchPlaceholder}
            value={(table.getColumn(searchKey)?.getFilterValue() as string) ?? ""}
            onChange={(event) =>
              table.getColumn(searchKey)?.setFilterValue(event.target.value)
            }
            className="max-w-sm"
          />
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="ml-auto">
              Columns
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {table
              .getAllColumns()
              .filter((column) => column.getCanHide())
              .map((column) => {
                return (
                  <DropdownMenuCheckboxItem
                    key={column.id}
                    className="capitalize"
                    checked={column.getIsVisible()}
                    onCheckedChange={(value) => column.toggleVisibility(!!value)}
                  >
                    {column.id}
                  </DropdownMenuCheckboxItem>
                );
              })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext()
                        )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() && "selected"}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  No results.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          {table.getFilteredSelectedRowModel().rows.length} of{" "}
          {table.getFilteredRowModel().rows.length} row(s) selected.
        </div>
        <div className="flex items-center space-x-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
```

### 3. Use in Page

```tsx
// app/dashboard/orders/page.tsx
import { columns } from "./columns";
import { DataTable } from "@/components/data-table";
import { getOrders } from "@/lib/metrics";

export default async function OrdersPage() {
  const orders = await getOrders();

  return (
    <div className="container mx-auto py-10">
      <h1 className="text-2xl font-bold mb-6">Orders</h1>
      <DataTable
        columns={columns}
        data={orders}
        searchKey="customer"
        searchPlaceholder="Search customers..."
      />
    </div>
  );
}
```

---

## Advanced Features

### Row Selection with Checkbox

```tsx
// Add to columns.tsx
import { Checkbox } from "@/components/ui/checkbox";

// Add as first column
{
  id: "select",
  header: ({ table }) => (
    <Checkbox
      checked={table.getIsAllPageRowsSelected()}
      onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
      aria-label="Select all"
    />
  ),
  cell: ({ row }) => (
    <Checkbox
      checked={row.getIsSelected()}
      onCheckedChange={(value) => row.toggleSelected(!!value)}
      aria-label="Select row"
    />
  ),
  enableSorting: false,
  enableHiding: false,
},
```

### Status Filter Dropdown

```tsx
// Add to data-table.tsx toolbar
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// In toolbar section
<Select
  value={(table.getColumn("status")?.getFilterValue() as string) ?? "all"}
  onValueChange={(value) =>
    table.getColumn("status")?.setFilterValue(value === "all" ? "" : value)
  }
>
  <SelectTrigger className="w-[180px]">
    <SelectValue placeholder="Filter by status" />
  </SelectTrigger>
  <SelectContent>
    <SelectItem value="all">All Status</SelectItem>
    <SelectItem value="pending">Pending</SelectItem>
    <SelectItem value="processing">Processing</SelectItem>
    <SelectItem value="completed">Completed</SelectItem>
    <SelectItem value="cancelled">Cancelled</SelectItem>
  </SelectContent>
</Select>
```

### Date Range Filter

```tsx
// Add date range picker to toolbar
import { DatePickerWithRange } from "@/components/ui/date-range-picker";

const [dateRange, setDateRange] = useState<DateRange | undefined>();

// Filter logic
useEffect(() => {
  if (dateRange?.from && dateRange?.to) {
    table.getColumn("createdAt")?.setFilterValue([dateRange.from, dateRange.to]);
  } else {
    table.getColumn("createdAt")?.setFilterValue(undefined);
  }
}, [dateRange, table]);
```

### Server-Side Pagination

```tsx
// For large datasets, use server-side pagination
interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  pageCount: number;
  pageIndex: number;
  pageSize: number;
  onPaginationChange: (pageIndex: number, pageSize: number) => void;
}

// In useReactTable config
manualPagination: true,
pageCount: pageCount,
state: {
  pagination: {
    pageIndex,
    pageSize,
  },
},
onPaginationChange: (updater) => {
  const newState = typeof updater === "function"
    ? updater({ pageIndex, pageSize })
    : updater;
  onPaginationChange(newState.pageIndex, newState.pageSize);
},
```

---

## Common Column Types for BI

### Currency Column

```tsx
{
  accessorKey: "revenue",
  header: () => <div className="text-right">Revenue</div>,
  cell: ({ row }) => {
    const amount = parseFloat(row.getValue("revenue"));
    return (
      <div className="text-right font-medium">
        {new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "USD",
        }).format(amount)}
      </div>
    );
  },
}
```

### Percentage Column

```tsx
{
  accessorKey: "conversionRate",
  header: "Conversion",
  cell: ({ row }) => {
    const rate = parseFloat(row.getValue("conversionRate"));
    return (
      <div className={rate >= 5 ? "text-green-600" : "text-red-600"}>
        {rate.toFixed(2)}%
      </div>
    );
  },
}
```

### Progress Bar Column

```tsx
{
  accessorKey: "progress",
  header: "Progress",
  cell: ({ row }) => {
    const progress = parseFloat(row.getValue("progress"));
    return (
      <div className="w-full bg-gray-200 rounded-full h-2.5">
        <div
          className="bg-blue-600 h-2.5 rounded-full"
          style={{ width: `${progress}%` }}
        />
      </div>
    );
  },
}
```

### Trend Indicator Column

```tsx
{
  accessorKey: "trend",
  header: "Trend",
  cell: ({ row }) => {
    const trend = parseFloat(row.getValue("trend"));
    const isPositive = trend >= 0;
    return (
      <div className={`flex items-center ${isPositive ? "text-green-600" : "text-red-600"}`}>
        {isPositive ? <TrendingUp className="h-4 w-4 mr-1" /> : <TrendingDown className="h-4 w-4 mr-1" />}
        {Math.abs(trend).toFixed(1)}%
      </div>
    );
  },
}
```

---

## Integration with Dashboard Layout

```tsx
// Dashboard with both charts and table
<div className="space-y-6">
  {/* KPI Cards */}
  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
    <KPICard title="Total Revenue" value="$45,231" />
    <KPICard title="Orders" value="1,234" />
    <KPICard title="Customers" value="567" />
    <KPICard title="Avg Order" value="$36.68" />
  </div>

  {/* Charts Row */}
  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
    <Card>
      <CardHeader>
        <CardTitle>Revenue Trend</CardTitle>
      </CardHeader>
      <CardContent>
        <RevenueChart data={revenueData} />
      </CardContent>
    </Card>
    <Card>
      <CardHeader>
        <CardTitle>Category Distribution</CardTitle>
      </CardHeader>
      <CardContent>
        <CategoryPieChart data={categoryData} />
      </CardContent>
    </Card>
  </div>

  {/* Data Table */}
  <Card>
    <CardHeader>
      <CardTitle>Recent Orders</CardTitle>
    </CardHeader>
    <CardContent>
      <DataTable columns={columns} data={orders} searchKey="customer" />
    </CardContent>
  </Card>
</div>
```

---

## Export Table Data

```tsx
// Add export button to toolbar
import { Download } from "lucide-react";

function exportToCSV<TData>(data: TData[], filename: string) {
  const headers = Object.keys(data[0] as object);
  const csvContent = [
    headers.join(","),
    ...data.map((row) =>
      headers.map((header) => JSON.stringify((row as any)[header] ?? "")).join(",")
    ),
  ].join("\n");

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${filename}.csv`;
  link.click();
}

// In toolbar
<Button
  variant="outline"
  size="sm"
  onClick={() => exportToCSV(table.getFilteredRowModel().rows.map(row => row.original), "export")}
>
  <Download className="mr-2 h-4 w-4" />
  Export
</Button>
```
