# The verbose listing supplies link targets which the name listing omits.
# Resolve relative targets against their member's directory before stripping
# the archive root. Symlinks used by Node's npm remain inside that root.
function safe(path,    parts,count,i,depth) {
  if (path ~ /^\// || path ~ /\\/ || path ~ /^[A-Za-z]:/) return 0
  count=split(path,parts,"/"); depth=0
  for (i=1;i<=count;i++) {
    if (parts[i]=="." || parts[i]=="") continue
    if (parts[i]=="..") { if (depth<=strip) return 0; depth-- }
    else depth++
  }
  return depth>=strip
}
{
  kind=substr($0,1,1)
  if (kind ~ /[bcp]/) exit 1
  separator=index($0," -> ")
  hard=index($0," link to ")
  hardLength=9
  if (!hard) { hard=index($0," == "); hardLength=4 }
  if (kind == "l" || kind == "h" || hard) {
    if (!separator && !hard) exit 1
    boundary=separator ? separator : hard
    target=substr($0,boundary+(separator ? 4 : hardLength))
    if (target ~ /^\// || target ~ /\\/ || target ~ /^[A-Za-z]:/) exit 1
    prefix=substr($0,1,boundary-1)
    # Archive member paths with spaces are accepted for regular files, but
    # ambiguous verbose link listings fail rather than guessing a target.
    fieldCount=split(prefix,fields,/[[:space:]]+/)
    member=fields[fieldCount]
    if (separator) { sub(/[^\/]+$/,"",member); target=member target }
    if (!safe(target)) exit 1
  }
}
