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
  name           = "<{ digitalocean-name }>"
  node_names     = <{ node-names-hcl|safe }>
  ssh_keys       = <{ ssh-keys-hcl|safe }>
  ssh_sources    = <{ ssh-sources-hcl|safe }>
  client_sources = <{ client-sources-hcl|safe }>
}

data "digitalocean_vpc" "default" {
  region = "<{ digitalocean-region }>"
}

resource "digitalocean_droplet" "node" {
  count    = length(local.node_names)
  name     = local.node_names[count.index]
  region   = "<{ digitalocean-region }>"
  size     = "<{ digitalocean-size }>"
  image    = "<{ digitalocean-image }>"
  vpc_uuid = data.digitalocean_vpc.default.id
  ssh_keys = local.ssh_keys
  tags     = ["colors-postgres-agy", local.name]

  lifecycle {
    prevent_destroy = <{ compute-prevent-destroy }>
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
    port_range       = "<{ haproxy-primary-port }>"
    source_addresses = local.client_sources
  }
  inbound_rule {
    protocol         = "tcp"
    port_range       = "<{ haproxy-replica-port }>"
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
    prevent_destroy = <{ compute-prevent-destroy }>
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

# The Compute Cluster Standard's `params`: the one output every later stage
# reads. The outputs above stay so no state output disappears; after adoption
# nothing reads them but the legacy translation.
output "params" {
  value = {
    provider     = "digitalocean"
    vpc_id       = data.digitalocean_vpc.default.id
    vpc_ip_range = data.digitalocean_vpc.default.ip_range
    nodes = [for i, d in digitalocean_droplet.node : {
      index  = i
      role   = null
      name   = d.name
      ip     = d.ipv4_address
      vpc_ip = d.ipv4_address_private
      user   = "root"
      sudoer = "root"
    }]
  }
}
