terraform {
  required_version = ">= 1.8.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

provider "cloudflare" {}

data "cloudflare_zone" "domain" {
  filter = {
    name = "<{ cloudflare-zone }>"
  }
}

<% for node in nodes %>
resource "cloudflare_dns_record" "endpoint_<{ node.ordinal }>" {
  zone_id = data.cloudflare_zone.domain.id
  name    = "<{ cluster-host }>"
  content = "<{ node.public-ip }>"
  type    = "A"
  proxied = <{ cloudflare-proxied }>
  ttl     = <{ cloudflare-record-ttl }>
  comment = "colors postgres-agy <{ node.name }>"
}
<% endfor %>

output "endpoint" {
  value = "<{ cluster-host }>"
}
