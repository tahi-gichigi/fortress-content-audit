"use client"

import * as React from "react"
import {
  ColumnDef,
  ColumnFiltersState,
  Row,
  RowSelectionState,
  SortingState,
  VisibilityState,
  flexRender,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table"
import { cn } from "@/lib/utils"
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
  ChevronsUpDownIcon,
  EyeIcon,
  Loader2,
  MoreVerticalIcon,
  SearchIcon,
  XIcon,
  RotateCcwIcon,
  Circle,
} from "lucide-react"
import { useToast } from "@/hooks/use-toast"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import {
  AuditTableRow,
  getSeverityBadgeVariant,
  filterBySeverity,
} from "@/lib/audit-table-adapter"
import { IssueStatus } from "@/types/fortress"
import { createClient } from "@/lib/supabase-browser"
import { EmptyAuditState } from "@/components/empty-audit-state"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

// Create columns factory function to accept state update handlers
function createColumns(
  onUpdateStatus?: (issueId: string, status: IssueStatus) => Promise<void>,
  userPlan?: string,
  currentStateTab?: 'active' | 'ignored' | 'resolved' | 'all',
  hideSelectAndActions?: boolean
): ColumnDef<AuditTableRow>[] {
  const columns: ColumnDef<AuditTableRow>[] = [];

  // Conditionally add select column
  if (!hideSelectAndActions) {
    columns.push({
      id: "select",
      header: ({ table }) => (
        <div className="flex items-center justify-center">
          <Checkbox
            checked={
              table.getIsAllPageRowsSelected() ||
              (table.getIsSomePageRowsSelected() && "indeterminate")
            }
            onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
            aria-label="Select all"
          />
        </div>
      ),
      cell: ({ row }) => (
        <div className="flex items-center justify-center">
          <Checkbox
            checked={row.getIsSelected()}
            onCheckedChange={(value) => row.toggleSelected(!!value)}
            aria-label="Select row"
          />
        </div>
      ),
      enableSorting: false,
      enableHiding: false,
    });
  }

  // Add main content columns
  columns.push({
      accessorKey: "issue_description",
      header: "Issue",
      size: 350,
      minSize: 280,
      cell: ({ row }) => {
        // Parse issue_description to extract impact prefix and description
        const description = row.original.issue_description
        const colonIndex = description.indexOf(':')
        const impactPrefix = colonIndex > 0 ? description.substring(0, colonIndex).trim() : ''
        const issueText = colonIndex > 0 ? description.substring(colonIndex + 1).trim() : description

        return (
          <div className="flex-1">
            {impactPrefix && (
              <span className="text-xs text-muted-foreground uppercase tracking-wide mr-2">{impactPrefix}</span>
            )}
            <span className="font-medium">{issueText}</span>
          </div>
        )
      },
      enableHiding: false,
      sortingFn: (rowA, rowB) => {
        const order = { critical: 0, medium: 1, low: 2 }
        return order[rowA.original.severity] - order[rowB.original.severity]
      },
    },
    {
      accessorKey: "suggested_fix",
      header: "Fix",
      size: 350,
      minSize: 280,
      cell: ({ row }) => (
        <div className="text-sm text-muted-foreground break-words">
          {row.original.suggested_fix || '—'}
        </div>
      ),
    },
    {
      accessorKey: "severity",
      header: "Severity",
      cell: ({ row }) => {
        const severity = row.original.severity
        const variant = getSeverityBadgeVariant(severity)
        
        return (
          <Badge variant={variant} className="capitalize">
            {severity}
          </Badge>
        )
      },
    },
    {
      accessorKey: "page_url",
      header: () => <div className="w-full text-right">Page</div>,
      cell: ({ row }) => {
        const url = row.original.page_url
        
        if (!url) {
          return <div className="text-right text-sm text-muted-foreground">—</div>
        }
        
        // Parse URL to show just the path/slug for better glanceability
        let displayUrl = url
        try {
          const urlObj = new URL(url)
          let path = urlObj.pathname
          
          // Remove trailing slash for cleaner display
          if (path.endsWith('/') && path.length > 1) {
            path = path.slice(0, -1)
          }
          
          // Extract just the last segment (slug) if path is long
          if (path.length > 35) {
            const segments = path.split('/').filter(s => s)
            if (segments.length > 0) {
              // Show last 2 segments if available, otherwise just last one
              const lastSegments = segments.slice(-2).join('/')
              displayUrl = `/${lastSegments.length > 30 ? lastSegments.substring(0, 27) + '...' : lastSegments}`
            } else {
              displayUrl = path.substring(0, 32) + '...'
            }
          } else if (path.length > 1) {
            displayUrl = path
          } else {
            // Root path - show domain
            displayUrl = urlObj.hostname.replace('www.', '')
          }
        } catch {
          // Fallback: simple truncation if URL parsing fails
          displayUrl = url.length > 35 ? `${url.substring(0, 32)}...` : url
        }
        
        return (
          <div className="text-right">
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-primary hover:underline truncate block max-w-full"
              title={url}
              onClick={(e) => e.stopPropagation()}
            >
              {displayUrl}
            </a>
          </div>
        )
      },
    });

  // Add row menu (three dots) on far right
  columns.push({
    id: "actions",
    enableHiding: false,
    cell: ({ row }) => {
      const issueId = row.original.id
      const currentStatus = row.original.status || 'active'

      if (!onUpdateStatus || !issueId) {
        return null
      }

      return (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="h-8 w-8 p-0">
              <span className="sr-only">Open menu</span>
              <MoreVerticalIcon className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {currentStatus === 'active' && (
              <>
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation()
                    onUpdateStatus(issueId, 'resolved')
                  }}
                >
                  <CheckCircle2Icon className="mr-2 h-4 w-4 text-green-600" />
                  Resolve
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation()
                    onUpdateStatus(issueId, 'ignored')
                  }}
                >
                  <XIcon className="mr-2 h-4 w-4 text-destructive" />
                  Ignore
                </DropdownMenuItem>
              </>
            )}
            {(currentStatus === 'resolved' || currentStatus === 'ignored') && (
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation()
                  onUpdateStatus(issueId, 'active')
                }}
              >
                <RotateCcwIcon className="mr-2 h-4 w-4" />
                Restore
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )
    },
  });

  return columns;
}

// Issue actions component (inline buttons)
function IssueActions({
  issueId,
  currentStatus,
  onUpdateStatus,
  inline = false,
}: {
  issueId: string
  currentStatus: IssueStatus
  onUpdateStatus: (issueId: string, status: IssueStatus) => Promise<void>
  inline?: boolean
}) {
  const [isUpdating, setIsUpdating] = React.useState(false)
  const { toast } = useToast()

  const isResolved = currentStatus === 'resolved'
  const isIgnored = currentStatus === 'ignored'

  const handleStatusUpdate = async (e: React.MouseEvent, status: IssueStatus) => {
    e.stopPropagation()
    setIsUpdating(true)
    try {
      await onUpdateStatus(issueId, status)

      let title = "Status updated"
      let description = "Issue status has been updated."

      if (status === 'resolved') {
        title = "Issue resolved"
        description = "Great job! The issue has been marked as resolved."
      } else if (status === 'ignored') {
        title = "Issue ignored"
        description = "The issue has been moved to ignored."
      } else if (status === 'active') {
        title = "Issue restored"
        description = "The issue has been restored to active."
      }

      toast({
        title,
        description,
      })
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to update issue status. Please try again.",
        variant: "error",
      })
    } finally {
      setIsUpdating(false)
    }
  }

  if (isResolved || isIgnored) {
    return (
      <div className={`flex items-center ${inline ? 'opacity-0 group-hover:opacity-100 transition-opacity duration-200' : 'justify-end'}`}>
        <Button
          variant="ghost"
          size={inline ? "sm" : "sm"}
          onClick={(e) => handleStatusUpdate(e, 'active')}
          disabled={isUpdating}
          className={`h-8 ${inline ? 'px-2 text-xs' : 'px-2'} text-muted-foreground hover:text-foreground transition-colors duration-200`}
          title="Restore to active"
        >
          {isUpdating ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <>
              <RotateCcwIcon className="mr-1.5 h-3.5 w-3.5" />
              {inline ? 'Restore' : 'Restore'}
            </>
          )}
        </Button>
      </div>
    )
  }

  return (
    <div className={`flex items-center gap-1 ${inline ? 'opacity-0 group-hover:opacity-100 transition-opacity duration-200' : 'justify-end'}`}>
      <Button
        variant="ghost"
        size="icon"
        onClick={(e) => handleStatusUpdate(e, 'resolved')}
        disabled={isUpdating}
        className="h-8 w-8 text-muted-foreground hover:text-green-600 hover:bg-green-50 dark:hover:bg-green-950/20 transition-colors duration-200"
        title="Mark as resolved"
      >
        {isUpdating ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <CheckCircle2Icon className="h-4 w-4" />
        )}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={(e) => handleStatusUpdate(e, 'ignored')}
        disabled={isUpdating}
        className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors duration-200"
        title="Ignore issue"
      >
        {isUpdating ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <XIcon className="h-4 w-4" />
        )}
      </Button>
    </div>
  )
}

// Simple row component with smooth collapse animations
function ExpandableRow({ row, exitingRowIds, isPreview }: { row: Row<AuditTableRow>, exitingRowIds: Set<string>, isPreview?: boolean }) {
  const isExiting = exitingRowIds.has(row.id)
  const rowRef = React.useRef<HTMLTableRowElement>(null)
  const [rowHeight, setRowHeight] = React.useState<number | null>(null)

  // Measure row height when it starts exiting
  React.useEffect(() => {
    if (isExiting && rowRef.current && rowHeight === null) {
      const height = rowRef.current.getBoundingClientRect().height
      setRowHeight(height)
    }
  }, [isExiting, rowHeight])

  return (
    <TableRow
      ref={rowRef}
      data-state={row.getIsSelected() && "selected"}
      className={`${
        isExiting
          ? 'opacity-0'
          : 'opacity-100'
      }`}
      style={{
        maxHeight: isExiting && rowHeight ? `${rowHeight}px` : undefined,
        overflow: isExiting ? 'hidden' : 'visible',
        transition: isExiting
          ? 'max-height 400ms cubic-bezier(0.4, 0, 0.2, 1), opacity 400ms cubic-bezier(0.4, 0, 0.2, 1), padding 400ms cubic-bezier(0.4, 0, 0.2, 1)'
          : 'all 300ms cubic-bezier(0.4, 0.2, 0.2, 1)',
        ...(isExiting && rowHeight ? {
          maxHeight: 0,
          paddingTop: 0,
          paddingBottom: 0,
        } : {}),
      }}
    >
      {row.getVisibleCells().map((cell) => {
        const isFixColumn = cell.column.id === 'suggested_fix'
        const isIssueColumn = cell.column.id === 'issue_description'
        // Wider columns for preview (homepage) for better readability
        const columnWidth = isFixColumn || isIssueColumn ? (isPreview ? '450px' : '350px') : undefined
        return (
          <TableCell
            key={cell.id}
            style={{
              ...(columnWidth ? { minWidth: columnWidth, width: columnWidth } : {}),
              ...(isExiting ? { paddingTop: 0, paddingBottom: 0 } : {}),
            }}
            // More vertical padding for homepage preview
            className={cn(
              "transition-all duration-200",
              isPreview && "py-6"
            )}
          >
            {flexRender(cell.column.columnDef.cell, cell.getContext())}
          </TableCell>
        )
      })}
    </TableRow>
  )
}

export function DataTable({
  data: initialData,
  auditId,
  userPlan,
  hideSearch = false,
  hideTabs = false,
  readOnly = false,
  onStatusUpdate,
  initialSeverityFilter,
  hidePagination = false,
  hideSelectAndActions = false,
  loading = false,
}: {
  data: AuditTableRow[]
  auditId?: string
  userPlan?: string
  hideSearch?: boolean
  hideTabs?: boolean
  readOnly?: boolean
  onStatusUpdate?: () => void
  initialSeverityFilter?: 'all' | 'critical' | 'medium' | 'low'
  hidePagination?: boolean
  hideSelectAndActions?: boolean
  loading?: boolean
}) {
  const { toast } = useToast()
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({})
  const [columnVisibility, setColumnVisibility] =
    React.useState<VisibilityState>({})
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>(
    []
  )
  // Sort by severity by default: Critical → Medium → Low (via issue_description column sorting function)
  const severityOrder = { critical: 0, medium: 1, low: 2 }
  const [sorting, setSorting] = React.useState<SortingState>([
    {
      id: "issue_description",
      desc: false, // Ascending: Critical first
    },
  ])
  const [pagination, setPagination] = React.useState({
    pageIndex: 0,
    pageSize: 10,
  })
  const [activeSeverityTab, setActiveSeverityTab] = React.useState<"all" | "critical" | "medium" | "low">(
    initialSeverityFilter || "all"
  )
  
  // Update severity tab when initialSeverityFilter prop changes
  React.useEffect(() => {
    if (initialSeverityFilter) {
      setActiveSeverityTab(initialSeverityFilter)
    }
  }, [initialSeverityFilter])
  const [activeStateTab, setActiveStateTab] = React.useState<'all' | 'active' | 'ignored' | 'resolved'>('active')
  const [isBulkProcessing, setIsBulkProcessing] = React.useState(false)
  const [globalFilter, setGlobalFilter] = React.useState("")
  const [data, setData] = React.useState(initialData)
  const [exitingRowIds, setExitingRowIds] = React.useState<Set<string>>(new Set())
  // Store initial data in ref to avoid dependency issues
  const initialDataRef = React.useRef(initialData)

  // Update data and ref when initialData changes
  React.useEffect(() => {
    initialDataRef.current = initialData
    setData(initialData)
  }, [initialData])

  // Update issue status handler with optimistic updates
  const handleUpdateStatus = React.useCallback(async (issueId: string, newStatus: IssueStatus) => {
    if (readOnly) {
      return // Don't allow updates in read-only mode
    }

    if (!auditId) {
      throw new Error('Audit ID required')
    }

    const supabase = createClient()
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) {
      throw new Error('Not authenticated')
    }

    // Store previous state for potential revert
    let previousData: AuditTableRow[] | null = null

    // Mark row as exiting if status is changing away from current tab's status
    const currentRow = data.find(item => item.id === issueId)
    if (currentRow && currentRow.status !== newStatus &&
        ((activeStateTab === 'active' && newStatus !== 'active') ||
         (activeStateTab === 'resolved' && newStatus !== 'resolved') ||
         (activeStateTab === 'ignored' && newStatus !== 'ignored'))) {
      setExitingRowIds(prev => new Set([...prev, issueId]))
      // Remove from exiting set after animation completes
      setTimeout(() => {
        setExitingRowIds(prev => {
          const newSet = new Set(prev)
          newSet.delete(issueId)
          return newSet
        })
      }, 400)
    }

    // Optimistic update
    setData(prevData => {
      previousData = prevData
      return prevData.map(item =>
        item.id === issueId ? { ...item, status: newStatus } : item
      )
    })

    try {
      const response = await fetch(`/api/audit/${auditId}/issues/${issueId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ status: newStatus }),
      })

      if (!response.ok) {
        // Revert optimistic update on error
        if (previousData) {
          setData(previousData)
        } else {
          setData(initialDataRef.current)
        }
        const error = await response.json().catch(() => ({ error: 'Failed to update status' }))
        throw new Error(error.error || 'Failed to update status')
      }

      // Trigger refetch in parent component
      if (onStatusUpdate) {
        onStatusUpdate()
      }
    } catch (error) {
      // Revert optimistic update on error
      if (previousData) {
        setData(previousData)
      } else {
        setData(initialDataRef.current)
      }
      throw error
    }
  }, [auditId, readOnly, onStatusUpdate, data, activeStateTab])

  // Bulk update issue status handler with optimistic updates
  const handleBulkUpdateStatus = React.useCallback(async (issueIds: string[], newStatus: IssueStatus) => {
    if (!auditId) {
      throw new Error('Audit ID required')
    }

    const supabase = createClient()
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) {
      throw new Error('Not authenticated')
    }

    // Store previous state for potential revert
    let previousData: AuditTableRow[] | null = null

    // Mark rows as exiting if they're changing away from current tab's status
    const rowsToAnimate = data.filter(item =>
      issueIds.includes(item.id) && item.status !== newStatus &&
      ((activeStateTab === 'active' && newStatus !== 'active') ||
       (activeStateTab === 'resolved' && newStatus !== 'resolved') ||
       (activeStateTab === 'ignored' && newStatus !== 'ignored'))
    ).map(item => item.id)

    if (rowsToAnimate.length > 0) {
      setExitingRowIds(prev => new Set([...prev, ...rowsToAnimate]))
      // Remove from exiting set after animation completes
      setTimeout(() => {
        setExitingRowIds(prev => {
          const newSet = new Set(prev)
          rowsToAnimate.forEach(id => newSet.delete(id))
          return newSet
        })
      }, 400)
    }

    // Optimistic update
    setData(prevData => {
      previousData = prevData
      return prevData.map(item =>
        issueIds.includes(item.id) ? { ...item, status: newStatus } : item
      )
    })

    try {
      const response = await fetch(`/api/audit/${auditId}/issues/bulk`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ issueIds, status: newStatus }),
      })

      if (!response.ok) {
        // Revert optimistic update on error
        if (previousData) {
          setData(previousData)
        } else {
          setData(initialDataRef.current)
        }
        const error = await response.json().catch(() => ({ error: 'Failed to update status' }))
        throw new Error(error.error || 'Failed to update status')
      }

      const result = await response.json()
      return result
    } catch (error) {
      // Revert optimistic update on error
      if (previousData) {
        setData(previousData)
      } else {
        setData(initialDataRef.current)
      }
      throw error
    }
  }, [auditId, data, activeStateTab])

  // Filter data by status first, then by severity
  // Keep exiting rows in view while they animate
  const filteredByState = React.useMemo(() => {
    if (activeStateTab === 'all') {
      return data
    }
    return data.filter((row) => {
      const status = row.status || 'active'
      // Keep rows that are exiting with animation
      if (exitingRowIds.has(row.id)) {
        return true
      }
      return status === activeStateTab
    })
  }, [data, activeStateTab, exitingRowIds])

  // Filter data by severity
  const filteredData = React.useMemo(() => {
    return filterBySeverity(filteredByState, activeSeverityTab)
  }, [filteredByState, activeSeverityTab])

  // Reset pagination when severity or state filter changes (smooth, no jump)
  React.useEffect(() => {
    setPagination((prev) => ({ pageIndex: 0, pageSize: prev.pageSize }))
  }, [activeSeverityTab, activeStateTab])

  // Apply global filter (search) to filtered data
  const searchFilteredData = React.useMemo(() => {
    if (!globalFilter.trim()) return filteredData
    const searchLower = globalFilter.toLowerCase()
    return filteredData.filter((row) => {
      const matchesDescription = row.issue_description.toLowerCase().includes(searchLower)
      const matchesFix = row.suggested_fix?.toLowerCase().includes(searchLower) || false
      const matchesPageUrl = row.page_url?.toLowerCase().includes(searchLower) || false
      const matchesCategory = row.category?.toLowerCase().includes(searchLower) || false
      
      return matchesDescription || matchesFix || matchesPageUrl || matchesCategory
    })
  }, [filteredData, globalFilter])

  // Create columns with status handlers (only if not read-only)
  const columns = React.useMemo(
    () => createColumns(readOnly ? undefined : handleUpdateStatus, userPlan, activeStateTab, hideSelectAndActions),
    [handleUpdateStatus, userPlan, activeStateTab, readOnly, hideSelectAndActions]
  )

  const table = useReactTable({
    data: searchFilteredData,
    columns,
    state: {
      sorting,
      columnVisibility,
      rowSelection,
      columnFilters,
      pagination,
      globalFilter,
    },
    getRowId: (row) => row.id,
    enableRowSelection: true,
    onRowSelectionChange: setRowSelection,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onPaginationChange: setPagination,
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: "includesString",
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
  })

  // Count issues by severity for tabs
  const severityCounts = React.useMemo(() => {
    const counts = {
      all: filteredByState.length,
      critical: filteredByState.filter((item) => item.severity === "critical").length,
      medium: filteredByState.filter((item) => item.severity === "medium").length,
      low: filteredByState.filter((item) => item.severity === "low").length,
    }
    return counts
  }, [filteredByState])

  // Count issues by state for state tabs
  const stateCounts = React.useMemo(() => {
    const counts = {
      all: data.length,
      active: data.filter((item) => (item.status || 'active') === 'active').length,
      ignored: data.filter((item) => item.status === 'ignored').length,
      resolved: data.filter((item) => item.status === 'resolved').length,
    }
    return counts
  }, [data])

  // Get selected row IDs from rowSelection state
  const selectedRowIds = React.useMemo(() => {
    return Object.keys(rowSelection).filter(key => rowSelection[key] === true)
  }, [rowSelection])

  // Get selected rows with their data to check statuses
  const selectedRows = React.useMemo(() => {
    return table.getFilteredSelectedRowModel().rows.map(row => row.original)
  }, [table, rowSelection])

  // Check if selected issues can be restored (ignored or resolved)
  const canRestore = React.useMemo(() => {
    return selectedRows.some(row => row.status === 'ignored' || row.status === 'resolved')
  }, [selectedRows])

  // Check if selected issues can be ignored/resolved (active)
  const canIgnoreOrResolve = React.useMemo(() => {
    return selectedRows.some(row => (row.status || 'active') === 'active')
  }, [selectedRows])

  // Bulk action handlers - only apply to relevant issues
  const handleBulkResolve = React.useCallback(async () => {
    // Only resolve active issues
    const activeIssueIds = selectedRows
      .filter(row => (row.status || 'active') === 'active')
      .map(row => row.id)
    
    if (activeIssueIds.length === 0) return
    
    setIsBulkProcessing(true)
    try {
      await handleBulkUpdateStatus(activeIssueIds, 'resolved')
      const count = activeIssueIds.length
      toast({
        title: "Issues resolved",
        description: `${count} ${count === 1 ? 'issue' : 'issues'} marked as resolved.`,
      })
      table.resetRowSelection()
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to resolve issues. Please try again.",
        variant: "error",
      })
    } finally {
      setIsBulkProcessing(false)
    }
  }, [selectedRows, handleBulkUpdateStatus, table])

  const handleBulkIgnore = React.useCallback(async () => {
    // Only ignore active issues
    const activeIssueIds = selectedRows
      .filter(row => (row.status || 'active') === 'active')
      .map(row => row.id)
    
    if (activeIssueIds.length === 0) return
    
    setIsBulkProcessing(true)
    try {
      await handleBulkUpdateStatus(activeIssueIds, 'ignored')
      const count = activeIssueIds.length
      toast({
        title: "Issues ignored",
        description: `${count} ${count === 1 ? 'issue' : 'issues'} ignored.`,
      })
      table.resetRowSelection()
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to ignore issues. Please try again.",
        variant: "error",
      })
    } finally {
      setIsBulkProcessing(false)
    }
  }, [selectedRows, handleBulkUpdateStatus, table])

  const handleBulkRestore = React.useCallback(async () => {
    // Only restore ignored or resolved issues
    const restorableIssueIds = selectedRows
      .filter(row => row.status === 'ignored' || row.status === 'resolved')
      .map(row => row.id)
    
    if (restorableIssueIds.length === 0) return
    
    setIsBulkProcessing(true)
    try {
      await handleBulkUpdateStatus(restorableIssueIds, 'active')
      const count = restorableIssueIds.length
      toast({
        title: "Issues restored",
        description: `${count} ${count === 1 ? 'issue' : 'issues'} restored.`,
      })
      table.resetRowSelection()
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to restore issues. Please try again.",
        variant: "error",
      })
    } finally {
      setIsBulkProcessing(false)
    }
  }, [selectedRows, handleBulkUpdateStatus, table])

  const handleClearSelection = React.useCallback(() => {
    table.resetRowSelection()
  }, [table])

  // Render table content (reusable for both tabs and non-tabs mode)
  const tableContent = (
    <>
      <Card className="border border-border">
          <CardContent className="p-0">
            <div className="overflow-hidden">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-muted">
                  {table.getHeaderGroups().map((headerGroup) => (
                    <TableRow key={headerGroup.id}>
                      {headerGroup.headers.map((header) => {
                        // Mobile-friendly headers: abbreviate long labels
                        const headerId = header.id || ''
                        const mobileHeader = headerId === 'page_url' ? 'Page' : 
                                            headerId === 'issue_description' ? 'Issue' :
                                            headerId === 'suggested_fix' ? 'Fix' :
                                            headerId === 'severity' ? 'Sev.' :
                                            headerId
                        const isFixColumn = headerId === 'suggested_fix'
                        const isIssueColumn = headerId === 'issue_description'
                        // Wider columns for preview (homepage) for better readability
                        const columnWidth = (isFixColumn || isIssueColumn) ? (hideSelectAndActions ? '450px' : '350px') : undefined
                        return (
                          <TableHead
                            key={header.id}
                            colSpan={header.colSpan}
                            style={columnWidth ? { minWidth: columnWidth, width: columnWidth } : undefined}
                            className={cn(hideSelectAndActions && "py-5")}
                          >
                            {header.isPlaceholder ? null : (
                              <>
                                <span className="hidden md:inline">
                                  {flexRender(
                                    header.column.columnDef.header,
                                    header.getContext()
                                  )}
                                </span>
                                {mobileHeader && (
                                  <span className="md:hidden text-xs">
                                    {mobileHeader}
                                  </span>
                                )}
                              </>
                            )}
                          </TableHead>
                        )
                      })}
                    </TableRow>
                  ))}
                </TableHeader>
                <TableBody>
                  {table.getRowModel().rows?.length ? (
                    table.getRowModel().rows.map((row) => (
                      <ExpandableRow key={row.id} row={row} exitingRowIds={exitingRowIds} isPreview={hideSelectAndActions} />
                    ))
                  ) : (
                    <TableRow>
                      <TableCell
                        colSpan={columns.length}
                        className="h-32 text-center py-8"
                      >
                        {/* Use shared empty state when no filters are active (suppress during loading) */}
                        {!loading && (hideTabs || (activeStateTab === 'all' && activeSeverityTab === "all")) ? (
                          <EmptyAuditState variant="inline" />
                        ) : (
                          <div className="flex flex-col items-center justify-center gap-2">
                            <CheckCircle2Icon className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
                            <p className="text-sm font-medium text-foreground">
                              {activeStateTab !== 'all' && activeStateTab !== 'active'
                                ? `No ${activeStateTab} issues found`
                                : `No ${activeSeverityTab} severity issues found. Great job! ✅`
                              }
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {activeStateTab !== 'all' && activeStateTab !== 'active'
                                ? `Switch to a different tab to see issues.`
                                : `Your content audit found no issues${activeSeverityTab !== "all" && ` with ${activeSeverityTab} severity`}.`
                              }
                            </p>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      {!hidePagination && (
        <div className="flex items-center justify-between">
          <div className="hidden flex-1 text-sm text-muted-foreground lg:flex">
            {table.getFilteredSelectedRowModel().rows.length > 0 ? (
              <>
                {table.getFilteredSelectedRowModel().rows.length} of{" "}
                {table.getFilteredRowModel().rows.length} row(s) selected.
              </>
            ) : (
              <>
                Showing {table.getFilteredRowModel().rows.length} of {data.length} issue{table.getFilteredRowModel().rows.length !== 1 ? "s" : ""}
                {!hideTabs && activeSeverityTab !== "all" && ` (filtered by ${activeSeverityTab} severity)`}
              </>
            )}
          </div>
          <div className="flex w-full items-center gap-8 lg:w-fit">
            <div className="hidden items-center gap-2 lg:flex">
              <Label htmlFor="rows-per-page" className="text-sm font-medium">
                Rows per page
              </Label>
              <Select
                value={`${table.getState().pagination.pageSize}`}
                onValueChange={(value) => {
                  table.setPageSize(Number(value))
                }}
              >
                <SelectTrigger className="w-20" id="rows-per-page">
                  <SelectValue
                    placeholder={table.getState().pagination.pageSize}
                  />
                </SelectTrigger>
                <SelectContent side="top">
                  {[10, 20, 30, 40, 50].map((pageSize) => (
                    <SelectItem key={pageSize} value={`${pageSize}`}>
                      {pageSize}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex w-fit items-center justify-center text-sm font-medium">
              Page {table.getState().pagination.pageIndex + 1} of{" "}
              {table.getPageCount()}
            </div>
            <div className="ml-auto flex items-center gap-2 lg:ml-0">
              <Button
                variant="outline"
                className="hidden h-8 w-8 p-0 lg:flex"
                onClick={() => table.setPageIndex(0)}
                disabled={!table.getCanPreviousPage()}
              >
                <span className="sr-only">Go to first page</span>
                <ChevronsLeftIcon />
              </Button>
              <Button
                variant="outline"
                className="size-8"
                size="icon"
                onClick={() => table.previousPage()}
                disabled={!table.getCanPreviousPage()}
              >
                <span className="sr-only">Go to previous page</span>
                <ChevronLeftIcon />
              </Button>
              <Button
                variant="outline"
                className="size-8"
                size="icon"
                onClick={() => table.nextPage()}
                disabled={!table.getCanNextPage()}
              >
                <span className="sr-only">Go to next page</span>
                <ChevronRightIcon />
              </Button>
              <Button
                variant="outline"
                className="hidden size-8 lg:flex"
                size="icon"
                onClick={() => table.setPageIndex(table.getPageCount() - 1)}
                disabled={!table.getCanNextPage()}
              >
                <span className="sr-only">Go to last page</span>
                <ChevronsRightIcon />
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  )

  return (
    <div className="flex w-full flex-col justify-start gap-6">
      {hideTabs ? (
        // Simple table without tabs
        tableContent
      ) : (
        // Full table with tabs
        <Tabs
          value={activeSeverityTab}
          onValueChange={(value) => {
            setActiveSeverityTab(value as "all" | "critical" | "medium" | "low")
            // Pagination reset handled in useEffect above
          }}
          className="flex w-full flex-col justify-start gap-6"
        >
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4 flex-1 min-w-0">
            {/* Search Input */}
            {!hideSearch && (
              <div className="relative flex-1 max-w-sm">
                <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search issues..."
                  value={globalFilter}
                  onChange={(e) => setGlobalFilter(e.target.value)}
                  className="pl-9"
                />
              </div>
            )}
            {!hideTabs && (
              <>
                <Label htmlFor="severity-selector" className="sr-only">
                  Filter by Severity
                </Label>
                <Select 
                  value={activeSeverityTab} 
                  onValueChange={(value) => {
                    setActiveSeverityTab(value as "all" | "critical" | "medium" | "low")
                    // Pagination reset handled in useEffect above
                  }}
                >
                  <SelectTrigger
                    className="@4xl/main:hidden flex w-fit"
                    id="severity-selector"
                  >
                    <SelectValue placeholder="Filter by severity" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="high">Critical</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="low">Low</SelectItem>
                  </SelectContent>
                </Select>
                {/* Status Filter */}
                <Select 
                  value={activeStateTab} 
                  onValueChange={(value) => {
                    setActiveStateTab(value as 'all' | 'active' | 'ignored' | 'resolved')
                  }}
                >
                  <SelectTrigger className="w-auto min-w-[120px]">
                    <SelectValue>
                      {activeStateTab === 'all' && 'All Issues'}
                      {activeStateTab === 'active' && 'Active Issues'}
                      {activeStateTab === 'ignored' && 'Ignored Issues'}
                      {activeStateTab === 'resolved' && 'Resolved Issues'}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Issues</SelectItem>
                    <SelectItem value="active">Active Issues</SelectItem>
                    <SelectItem value="ignored">Ignored Issues</SelectItem>
                    <SelectItem value="resolved">Resolved Issues</SelectItem>
                  </SelectContent>
                </Select>
              </>
            )}
        {!hideTabs && (
          <div className="@4xl/main:flex hidden items-center gap-3">
            <TabsList>
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="critical">Critical</TabsTrigger>
              <TabsTrigger value="medium">Medium</TabsTrigger>
              <TabsTrigger value="low">Low</TabsTrigger>
            </TabsList>
            {/* Bulk action buttons - appear when items are selected */}
            {!readOnly && selectedRowIds.length > 0 && (
              <div className="flex items-center gap-2 animate-in fade-in-0 slide-in-from-right-2 duration-200">
                {canRestore && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleBulkRestore}
                    disabled={isBulkProcessing}
                    className="h-9 text-xs"
                  >
                    <RotateCcwIcon className="mr-1.5 h-3.5 w-3.5" />
                    Restore
                  </Button>
                )}
                {canIgnoreOrResolve && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleBulkIgnore}
                      disabled={isBulkProcessing}
                      className="h-9 text-xs"
                    >
                      <XIcon className="mr-1.5 h-3.5 w-3.5" />
                      Ignore
                    </Button>
                    <Button
                      variant="default"
                      size="sm"
                      onClick={handleBulkResolve}
                      disabled={isBulkProcessing}
                      className="h-9 text-xs"
                    >
                      {isBulkProcessing ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <CheckCircle2Icon className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      Resolve
                    </Button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
        </div>
        </div>
      </div>
          <TabsContent
            value={activeSeverityTab}
            className="relative flex flex-col gap-4"
          >
            {tableContent}
          </TabsContent>
        </Tabs>
      )}
    </div>
  )
}


