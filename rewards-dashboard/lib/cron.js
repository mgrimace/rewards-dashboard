'use strict'

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function to12h(hour, minute) {
    const h = ((hour % 12) + 12) % 12 || 12
    const period = hour < 12 ? 'AM' : 'PM'
    const mm = String(minute).padStart(2, '0')
    return `${h}:${mm} ${period}`
}

function parseField(field) {
    // Returns { every: n } for "*/n", or an explicit sorted number list otherwise.
    if (field === '*') return { any: true }
    const stepMatch = /^\*\/(\d+)$/.exec(field)
    if (stepMatch) return { every: Number(stepMatch[1]) }
    const values = field
        .split(',')
        .flatMap(part => {
            const rangeMatch = /^(\d+)-(\d+)$/.exec(part)
            if (rangeMatch) {
                const [, a, b] = rangeMatch
                const out = []
                for (let i = Number(a); i <= Number(b); i++) out.push(i)
                return out
            }
            return [Number(part)]
        })
        .filter(n => !Number.isNaN(n))
        .sort((a, b) => a - b)
    return { values }
}

function describeWeekdays(field) {
    if (field.any) return null
    if (field.every) return `every ${field.every} day(s) of the week`
    const names = field.values.map(d => DAY_NAMES[d % 7])
    const isWeekdays = field.values.length === 5 && [1, 2, 3, 4, 5].every(d => field.values.includes(d))
    const isWeekend = field.values.length === 2 && [0, 6].every(d => field.values.includes(d))
    if (isWeekdays) return 'weekdays'
    if (isWeekend) return 'weekends'
    return names.join(', ')
}

/**
 * Best-effort plain-English description of a standard 5-field cron
 * expression. Falls back to returning the raw expression for anything too
 * unusual to phrase cleanly (complex combinations of steps/ranges/lists
 * across multiple fields at once).
 */
function describeCron(expr) {
    if (!expr || typeof expr !== 'string') return null
    const parts = expr.trim().split(/\s+/)
    if (parts.length !== 5) return expr

    const [minuteRaw, hourRaw, domRaw, monthRaw, dowRaw] = parts
    const minute = parseField(minuteRaw)
    const hour = parseField(hourRaw)
    const dom = parseField(domRaw)
    const month = parseField(monthRaw)
    const dow = parseField(dowRaw)

    const dayRestricted = domRaw !== '*' || monthRaw !== '*'
    if (dayRestricted) return expr // month/day-of-month schedules: not worth guessing at, show raw

    // Every N minutes (e.g. "*/15 * * * *")
    if (minute.every && hour.any) {
        return `Every ${minute.every} minute${minute.every === 1 ? '' : 's'}`
    }

    // Every N hours (e.g. "0 */6 * * *")
    if (hour.every && minute.values?.length === 1 && minute.values[0] === 0) {
        return `Every ${hour.every} hour${hour.every === 1 ? '' : 's'}`
    }

    // Fixed minute, one or more fixed hours - the common case
    if (minute.values?.length === 1 && hour.values && !hour.every) {
        const times = hour.values.map(h => to12h(h, minute.values[0]))
        const dayPart = describeWeekdays(dow)
        const timesText = times.length === 1 ? times[0] : joinWithAnd(times)
        return dayPart ? `${capitalize(dayPart)} at ${timesText}` : `Daily at ${timesText}`
    }

    return expr // anything else: don't guess, just show the raw expression
}

function joinWithAnd(items) {
    if (items.length <= 1) return items.join('')
    if (items.length === 2) return `${items[0]} and ${items[1]}`
    return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

function capitalize(s) {
    return s.charAt(0).toUpperCase() + s.slice(1)
}

module.exports = { describeCron }
