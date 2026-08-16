terraform {
  required_version = ">= 1.8.0"
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.0"
    }
  }
}

provider "digitalocean" {}

locals {
  name           = "postgres-agy"
  node_names     = ["postgres-agy-1", "postgres-agy-2", "postgres-agy-3"]
  ssh_keys       = ["58495393"]
  ssh_sources    = ["129.159.242.163/32"]
  client_sources = ["129.159.242.163/32"]
}

data "digitalocean_vpc" "default" {
  region = "ams3"
}

resource "digitalocean_droplet" "node" {
  count    = length(local.node_names)
  name     = local.node_names[count.index]
  region   = "ams3"
  size     = "s-2vcpu-4gb"
  image    = "ubuntu-24-04-x64"
  vpc_uuid = data.digitalocean_vpc.default.id
  ssh_keys = local.ssh_keys
  tags     = ["colors-postgres-agy", local.name]

  lifecycle {
    prevent_destroy = true
  }
}

resource "digitalocean_firewall" "cluster" {
  name        = "${local.name}-firewall"
  droplet_ids = digitalocean_droplet.node[*].id

  # Administrative access
  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = local.ssh_sources
  }

  # Client access to HAProxy
  inbound_rule {
    protocol         = "tcp"
    port_range       = "5432"
    source_addresses = local.client_sources
  }
  inbound_rule {
    protocol         = "tcp"
    port_range       = "5433"
    source_addresses = local.client_sources
  }

  # Cluster internal traffic (streaming replication, etcd, Patroni REST API)
  inbound_rule {
    protocol         = "tcp"
    port_range       = "1-65535"
    source_addresses = [data.digitalocean_vpc.default.ip_range]
  }
  inbound_rule {
    protocol         = "udp"
    port_range       = "1-65535"
    source_addresses = [data.digitalocean_vpc.default.ip_range]
  }
  inbound_rule {
    protocol         = "icmp"
    source_addresses = concat(local.ssh_sources, [data.digitalocean_vpc.default.ip_range])
  }

  # Outbound is open for packages, etcd downloads, and R2 backups
  outbound_rule {
    protocol              = "tcp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "udp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "icmp"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  lifecycle {
    prevent_destroy = true
  }
}

output "vpc_id" {
  value = data.digitalocean_vpc.default.id
}

output "vpc_ip_range" {
  value = data.digitalocean_vpc.default.ip_range
}

output "node_public_ips" {
  value = digitalocean_droplet.node[*].ipv4_address
}

output "node_private_ips" {
  value = digitalocean_droplet.node[*].ipv4_address_private
}
