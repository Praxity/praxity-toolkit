# Bootstrap only needs scalar JSON values to locate Node. Full pack validation
# runs under that verified Node before any other artifact is installed.
function fail(message) { print "Invalid bootstrap JSON: " message > "/dev/stderr"; exit 1 }
function whitespace() { while (substr(json, pos, 1) ~ /[ \t\r\n]/ && pos <= length(json)) pos++ }
function string(    out,c,escape,hex,n,i,digits) {
  if (substr(json,pos++,1) != "\"") fail("expected string")
  out=""
  while (pos <= length(json)) {
    c=substr(json,pos++,1)
    if (c == "\"") return out
    if (c == "\\") {
      escape=substr(json,pos++,1)
      if (escape == "\"" || escape == "\\" || escape == "/") c=escape
      else if (escape == "u") {
        hex=substr(json,pos,4); pos+=4
        if (hex !~ /^[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]$/) fail("bad unicode escape")
        n=0; digits="0123456789abcdef"
        for (i=1;i<=4;i++) n=n*16+index(digits,tolower(substr(hex,i,1)))-1
        if (n<32 || n>126) fail("use literal UTF-8 for non-ASCII values")
        c=sprintf("%c",n)
      } else fail("control escapes are not allowed in bootstrap values")
    }
    if (c ~ /[[:cntrl:]]/) fail("control character in string")
    out=out c
  }
  fail("unterminated string")
}
function value(path,    c,key,indexValue,token,start) {
  whitespace(); c=substr(json,pos,1)
  if (c == "{" || c == "[") {
    pos++; whitespace(); indexValue=0
    if (substr(json,pos,1) == (c == "{" ? "}" : "]")) { pos++; return }
    while (1) {
      if (c == "{") {
        key=string(); whitespace()
        if (key !~ /^[a-zA-Z0-9_.-]+$/) fail("unsupported key")
        if (seen[path "/" key]++) fail("duplicate key")
        if (substr(json,pos++,1) != ":") fail("expected colon")
      } else key=indexValue++
      value(path "/" key); whitespace()
      token=substr(json,pos++,1)
      if (token == (c == "{" ? "}" : "]")) return
      if (token != ",") fail("expected comma")
      whitespace()
    }
  } else if (c == "\"") scalars[path]=string()
  else {
    start=pos
    while (pos<=length(json) && substr(json,pos,1) !~ /[ \t\r\n,}\]]/) pos++
    token=substr(json,start,pos-start)
    if (token !~ /^(true|false|null|-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?)$/) fail("invalid scalar")
    scalars[path]=token
  }
}
BEGIN {
  while ((getline line)>0) json=json line "\n"
  pos=1; value(""); whitespace()
  if (pos<=length(json)) fail("trailing JSON")
  for (path in scalars) print path "\t" scalars[path]
}
