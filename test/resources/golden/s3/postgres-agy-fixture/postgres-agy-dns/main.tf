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
    name = "bigconfig.online"
  }
}


resource "cloudflare_dns_record" "endpoint_1" {
  zone_id = data.cloudflare_zone.domain.id
  name    = "postgres-agy.bigconfig.online"
  content = "192.0.2.10"
  type    = "A"
  proxied = false
  ttl     = 60
  comment = "colors postgres-agy postgres-agy-0"
}

resource "cloudflare_dns_record" "endpoint_2" {
  zone_id = data.cloudflare_zone.domain.id
  name    = "postgres-agy.bigconfig.online"
  content = "192.0.2.11"
  type    = "A"
  proxied = false
  ttl     = 60
  comment = "colors postgres-agy postgres-agy-1"
}

resource "cloudflare_dns_record" "endpoint_3" {
  zone_id = data.cloudflare_zone.domain.id
  name    = "postgres-agy.bigconfig.online"
  content = "192.0.2.12"
  type    = "A"
  proxied = false
  ttl     = 60
  comment = "colors postgres-agy postgres-agy-2"
}


output "endpoint" {
  value = "postgres-agy.bigconfig.online"
}
