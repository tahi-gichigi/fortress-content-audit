"use client"

import { TrendingDownIcon, TrendingUpIcon, Minus } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { getHealthScoreTextColor } from "@/lib/health-score"

interface HealthScoreCardsProps {
  currentScore?: {
    score: number
    metrics?: {
      totalActive: number
      totalCritical: number
      pagesWithIssues: number
      criticalPages: number
    }
  }
  pagesAudited?: number | null
  previousScore?: number
  loading?: boolean
  onFilterChange?: (filter: 'all' | 'critical' | null) => void
  activeFilter?: 'all' | 'critical' | null // null means 'all' (show all), 'critical' means filter to critical
  onPagesWithIssuesClick?: () => void
}

export function HealthScoreCards({ 
  currentScore, 
  pagesAudited, 
  previousScore, 
  loading,
  onFilterChange,
  activeFilter = null,
  onPagesWithIssuesClick,
}: HealthScoreCardsProps) {
  // Show loading state only while actively loading
  if (loading) {
    return (
      <div className="@xl/main:grid-cols-2 @5xl/main:grid-cols-4 grid grid-cols-1 gap-4 px-4 lg:px-6">
        {[1, 2, 3, 4].map((i) => (
          <Card key={i} className="border border-border">
            <CardHeader>
              <CardDescription>Loading...</CardDescription>
              <CardTitle className="text-2xl font-semibold">-</CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>
    )
  }

  // If no data after loading, show empty state or don't render
  if (!currentScore) {
    return null
  }

  const score = Math.round(currentScore.score)
  const metrics: {
    totalActive: number
    totalCritical: number
    pagesWithIssues: number
    criticalPages: number
  } = currentScore.metrics || {
    totalActive: 0,
    totalCritical: 0,
    pagesWithIssues: 0,
    criticalPages: 0,
  }
  
  // Calculate trend
  const trend = previousScore !== undefined ? score - previousScore : 0
  const TrendIcon = trend > 0 ? TrendingUpIcon : trend < 0 ? TrendingDownIcon : Minus
  const trendColor = getHealthScoreTextColor(score)

  return (
    <div className="@xl/main:grid-cols-2 @5xl/main:grid-cols-4 grid grid-cols-1 gap-4 px-4 *:data-[slot=card]:shadow-xs *:data-[slot=card]:bg-gradient-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card dark:*:data-[slot=card]:bg-card lg:px-6">
      <Card className="@container/card border border-border">
        <CardHeader className="relative">
          <CardDescription>Health Score</CardDescription>
          <CardTitle className={`@[250px]/card:text-3xl text-2xl font-semibold tabular-nums ${getHealthScoreTextColor(score)}`}>
            {score}/100
          </CardTitle>
          {previousScore !== undefined && (
            <div className="absolute right-4 top-4">
              <Badge variant="outline" className={`flex gap-1 rounded-lg text-xs ${trendColor}`}>
                <TrendIcon className="size-3" />
                {trend > 0 ? '+' : ''}{trend.toFixed(0)}
              </Badge>
            </div>
          )}
        </CardHeader>
        <CardFooter className="flex-col items-start gap-1 text-sm">
          <div className="line-clamp-1 flex gap-2 font-medium">
            {score >= 95 ? 'Excellent content quality' :
             score >= 80 ? 'Good content quality' :
             score >= 50 ? 'Needs work' :
             'Poor content quality'}
            {trend > 0 && <TrendingUpIcon className="size-4" />}
            {trend < 0 && <TrendingDownIcon className="size-4" />}
          </div>
          <div className="text-muted-foreground">
            Content quality score based on active issues
          </div>
        </CardFooter>
      </Card>
      
      <Card 
        className={`@container/card border transition-all ${
          onFilterChange ? 'cursor-pointer hover:shadow-md hover:border-foreground/20' : ''
        } ${
          activeFilter === null ? 'ring-2 ring-primary/20 border-primary/30' : ''
        }`}
        onClick={() => onFilterChange && onFilterChange(null)}
      >
        <CardHeader className="relative">
          <CardDescription>Total Active Issues</CardDescription>
          <CardTitle className="@[250px]/card:text-3xl text-2xl font-semibold tabular-nums">
            {metrics.totalActive || 0}
          </CardTitle>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-1 text-sm">
          <div className="line-clamp-1 flex gap-2 font-medium">
            Active issues in current audit
          </div>
          <div className="text-muted-foreground">
            {onFilterChange ? 'Click to view all issues' : 'Excludes ignored and resolved issues'}
          </div>
        </CardFooter>
      </Card>
      
      <Card 
        className={`@container/card border transition-all ${
          onFilterChange ? 'cursor-pointer hover:shadow-md hover:border-rose-500/30' : ''
        } ${
          activeFilter === 'critical' ? 'ring-2 ring-rose-500/30 border-rose-500/50' : ''
        }`}
        onClick={() => onFilterChange && onFilterChange('critical')}
      >
        <CardHeader className="relative">
          <CardDescription>Critical Issues</CardDescription>
          <CardTitle className="@[250px]/card:text-3xl text-2xl font-semibold tabular-nums text-rose-500">
            {metrics.totalCritical || 0}
          </CardTitle>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-1 text-sm">
          <div className="line-clamp-1 flex gap-2 font-medium">
            High-severity issues requiring attention
          </div>
          <div className="text-muted-foreground">
            {onFilterChange ? 'Click to filter by critical issues' : 'Issues that impact user experience'}
          </div>
        </CardFooter>
      </Card>
      
      <Card
        className={`@container/card border transition-all ${
          onPagesWithIssuesClick ? 'cursor-pointer hover:shadow-md hover:border-foreground/20' : ''
        }`}
        onClick={onPagesWithIssuesClick ?? undefined}
      >
        <CardHeader className="relative">
          <CardDescription>
            {/* X/Y format makes the card self-explanatory at a glance */}
            Pages audited with issues
          </CardDescription>
          <CardTitle className="@[250px]/card:text-3xl text-2xl font-semibold tabular-nums">
            {pagesAudited !== null && pagesAudited !== undefined
              ? `${metrics.pagesWithIssues || 0} of ${pagesAudited}`
              : (metrics.pagesWithIssues || 0)
            }
          </CardTitle>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-1 text-sm">
          <div className="line-clamp-1 flex gap-2 font-medium">
            {pagesAudited !== null && pagesAudited !== undefined
              ? `${pagesAudited} pages audited`
              : 'Pages audited'}
          </div>
          <div className="text-muted-foreground">
            {onPagesWithIssuesClick
              ? 'Click to see which pages have issues'
              : `${metrics.pagesWithIssues || 0} had at least one content issue`}
          </div>
        </CardFooter>
      </Card>
    </div>
  )
}

