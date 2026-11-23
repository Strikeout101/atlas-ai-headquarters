"""
Builds ATLAS floor-1 furniture from the downloaded models and exports public/models/atlas/office-furniture.glb.

Run in Blender after build_atlas_shell.py:
    exec(open(r"C:\\Users\\Strikeout\\Projects\\atlas\\art\\blender\\build_atlas_furniture.py").read())

Pipeline per asset (ASSETS below):
  1. import (glb, or objects appended from a Poly Haven .blend)
  2. drop helper meshes (ground/shadow planes) and join into one object
  3. rotate so the asset's front faces -Y in Blender (= +Z "south" in three.js), drop to the floor, centre it
  4. scale to a real-world size, decimate heavy meshes, shrink and pack textures
Then each placement (PLACEMENTS) becomes a linked duplicate, so a shared mesh is stored once in the GLB.

Placement coordinates are three.js layout coordinates from src/components/atlas-office/layout.ts:
(x, z) on the floor, y up, rotation about the vertical axis in radians (0 = front faces south / +z).
Blender position = (x, -z, y); the rotation angle is the same about Blender's Z axis.
"""

import math
import os

import bmesh
import bpy
import numpy as np
from mathutils import Vector

import os
PROJECT = os.environ.get("ATLAS_PROJECT", r"C:\Users\Strikeout\Projects\atlas")
# Sources, by category: furniture/, electronics/, kitchen/, decor/, recreation/ (see Downloaded-Models/README.md).
SRC = os.path.join(PROJECT, "Downloaded-Models")
OUT = os.path.join(PROJECT, "public", "models", "atlas", "office-furniture.glb")
PROTOS = "ATLAS_Props"
PLACED = "ATLAS_Furniture"
PI = math.pi

# --- Asset preparation ------------------------------------------------------------------------
# src: glTF file, or blend: folder holding a Poly Haven .blend, both relative to SRC.
# turn: extra rotation (radians, about Z) so the front faces -Y. size: ("height"|"width"|"depth", metres).
# tris: decimate target (None = keep). tex: max texture size. drop_larger_than: remove meshes wider than this (m,
# measured before scaling, relative to the asset's own median) to strip ground/shadow planes.
ASSETS = {
    "monitor": dict(src="electronics/pc_monitor_-_curved.glb", turn=0.0, size=("width", 0.86), tris=3000, tex=512, split_screen=True),
    "keyboard_white": dict(src="electronics/keyboard.glb", turn=0.0, size=("width", 0.44), tris=1500, tex=256),
    "keyboard_slim": dict(src="electronics/apple_magic_keyboard_with_numeric_keyboard.glb", turn=0.0, size=("width", 0.42), tris=1500, tex=256),
    # The source model lies sideways with its buttons toward -X: a quarter turn puts them at the front (-Y).
    "mouse": dict(src="electronics/logitech_mx_master_2s_danish_blends.glb", turn=PI / 2, size=("depth", 0.12), tris=1200, tex=256),
    "pc_tower": dict(src="electronics/pc_gaming_ryzen_nvidia_1660.glb", turn=-PI / 2, size=("height", 0.46), tris=6000, tex=512),
    "office_chair": dict(src="furniture/office_chair.glb", turn=0.0, size=("height", 1.1), tris=None, tex=512),
    "executive_chair": dict(src="furniture/executive_chair.glb", turn=0.0, size=("height", 1.24), tris=12000, tex=1024),
    "executive_desk": dict(src="furniture/office_desk.glb", turn=0.0, size=("width", 2.1), tris=None, tex=1024),
    "bookshelf": dict(src="furniture/victorian_bookshelf.glb", turn=-PI / 2, size=("width", 2.4), tris=10000, tex=1024),
    "armchair": dict(blend="furniture/ArmChair_01_4k", turn=0.0, size=("height", 1.0), tris=None, tex=1024),
    "lounge_chair": dict(blend="furniture/mid_century_lounge_chair_4k", turn=0.0, size=("height", 1.0), tris=None, tex=1024),
    "sofa": dict(blend="furniture/sofa_03_4k", turn=0.0, size=("width", 2.4), tris=None, tex=1024),
    "tv": dict(src="electronics/tv_screen.glb", turn=0.0, size=("width", 2.2), tris=None, tex=512, split_tv=True),
    "arcade": dict(src="recreation/arcade_cabinet_elben_quest.glb", turn=PI / 2, size=("height", 1.8), tris=None, tex=1024),
    "kitchen_counter": dict(src="kitchen/a_kitchen_sink_with_cabinets_for_storage.glb", turn=PI / 2, size=("width", 1.9), tris=None, tex=1024),
    "espresso": dict(src="kitchen/espresso_machine.glb", turn=-PI / 2, size=("height", 0.34), tris=4000, tex=128),
    "trash_can": dict(src="decor/trash_can_-_vurvur_house_5.glb", turn=0.0, size=("height", 0.6), tris=None, tex=256),
    # Pool Table - Cycles by Jay-Artist (Blend Swap, CC BY 3.0): the table and balls (no studio floor, lights, cues).
    "pool_table": dict(blend="recreation/pool_table", turn=0.0, size=("height", 0.82), tris=20000, tex=1024,
                       drop_exact=["Studio-floor", "Light-top", "Light-left", "Light-right", "Cue1", "Cue2"]),
    # Sofa Array Modern (user-supplied): only the L-shaped 3-seater with its cushions.
    "corner_sofa": dict(blend="furniture/corner_sofa", turn=0.0, size=("width", 2.74), tris=20000, tex=1024,
                        keep_parent="Sofá Array 3L LVD"),
    "foosball": dict(src="recreation/marble_foosball.glb", turn=0.0, size=("width", 1.5), tris=12000, tex=512),
    "beanbag": dict(src="furniture/bean_bag.glb", turn=0.0, size=("height", 0.62), tris=None, tex=512),
    "coffee_table": dict(src="furniture/hooper_storage_coffee_table_table_walnut.glb", turn=0.0, size=("width", 1.2), tris=4000, tex=1024, drop_names=["FLOOR"]),
    "floor_lamp": dict(src="decor/bow_large_floor_lamp_black_and_white_marble.glb", turn=0.0, size=("height", 1.9), tris=4000, tex=512, drop_names=["FLOOR"]),
    "table_lamp": dict(src="decor/cohen_table_lamp_white_and_natural_oak.glb", turn=0.0, size=("height", 0.48), tris=3000, tex=256, drop_names=["FLOOR"]),
    "plant_tall": dict(src="decor/day_178_snake_plant.glb", turn=0.0, size=("height", 1.35), tris=8000, tex=1024),
    "plant_leafy": dict(src="decor/indoor_plant.glb", turn=0.0, size=("height", 1.25), tris=None, tex=1024),
}

# --- Placements (three.js layout coordinates; keep in sync with layout.ts) -----------------------
DESKS = [(-7.9, 0), (-4.1, 0), (-0.15, 0), (3.7, 0), (7.6, 0), (-8.4, 4.8), (-4.2, 4.8), (-0.15, 4.8), (4.0, 4.8), (8.2, 4.8)]
DESK_TOP_Y = 0.75
MEETING_TABLE = (3.65, -4.4)
# Replaces the scanned meeting set (its baked scan texture smeared orange/black blotches over the chairs and
# table): a procedural oak table with the desk chairs around it. Must match CONFERENCE_CHAIR_OFFSETS in layout.ts.
CONFERENCE_CHAIR_OFFSETS = [-1.85, -1.11, -0.37, 0.37, 1.11, 1.85]
# Chairs stand where a seated character's hips land: SIT_BACK (0.28 m) behind the spot it stands on to sit down.
# Keep in sync with CONFERENCE_CHAIR_Z, DESK_CHAIR_OFFSET and EXECUTIVE_CHAIR in layout.ts.
CONFERENCE_CHAIR_Z = 1.04
DESK_CHAIR_OFFSET = 0.83
EXECUTIVE_CHAIR = (-10.35, 4.1)
# Pieces that exist on one floor only are tagged (6th tuple field) and exported as "<floor>__<asset>_<n>", e.g.
# "director__executive_desk_0" or "lower__monitor_5"; the app shows each tagged piece on its floor only.
DIRECTOR, LOWER = "director", "lower"
# Desk 5 stands where the executive office is upstairs, so it is on the floor below only (DESK_INDICES_BY_FLOOR).
LOWER_ONLY_DESKS = {5}


def placements():
    items = []  # (asset, x, z, y, rotation[, floor tag])
    keyboards = ["keyboard_white", "keyboard_slim"]
    for i, (x, z) in enumerate(DESKS):
        tag = (LOWER,) if i in LOWER_ONLY_DESKS else ()
        items.append(("@desk", x, z, 0.0, 0.0, *tag))
        items.append(("monitor", x, z - 0.18, DESK_TOP_Y, 0.0, *tag))
        # Keyboard and mouse near the desk's front edge, within reach of the seated agent (whose hands are placed
        # on them by IK in the app). Keep in sync with DESK_KEYBOARD / DESK_MOUSE in layout.ts.
        items.append((keyboards[i % 2], x - 0.05, z + 0.31, DESK_TOP_Y, 0.0, *tag))
        items.append(("mouse", x + 0.34, z + 0.31, DESK_TOP_Y, PI, *tag))
        items.append(("pc_tower", x + 0.62, z - 0.05, 0.0, 0.0, *tag))
        # Chair pulled out from the desk, where the agent working there sits.
        items.append(("office_chair", x, z + DESK_CHAIR_OFFSET, 0.0, PI, *tag))
    # Executive office in the south-west corner (Director's floor only). The Director sits with his back to the
    # bookshelf on the west wall, facing east (+x) across the desk; the guest armchairs face him from the east.
    # A rotation of +PI/2 turns a piece's front east, -PI/2 west. Keep in sync with EXECUTIVE_FURNITURE in layout.ts.
    # monitor_10 (the Director's) must come right after the ten desk monitors.
    items += [
        ("executive_desk", -9.37, 4.1, 0.0, -PI / 2, DIRECTOR),
        ("monitor", -9.22, 4.1, DESK_TOP_Y, -PI / 2, DIRECTOR),
        ("table_lamp", -9.42, 4.85, DESK_TOP_Y, -PI / 2, DIRECTOR),
        ("executive_chair", EXECUTIVE_CHAIR[0], EXECUTIVE_CHAIR[1], 0.0, PI / 2, DIRECTOR),
        ("bookshelf", -11.28, 4.1, 0.0, PI / 2, DIRECTOR),
        ("armchair", -8.2, 3.55, 0.0, -PI / 2, DIRECTOR),
        ("armchair", -8.2, 4.65, 0.0, -PI / 2, DIRECTOR),
        ("lounge_chair", -6.75, 5.85, 0.0, -PI / 4, DIRECTOR),
        ("plant_leafy", -11.0, 6.0, 0.0, 0.0, DIRECTOR),
    ]
    # The old executive office's corner by the conference room: a pool table upstairs, a lounge nook downstairs.
    # Keep in sync with FURNITURE.poolTable and LOWER_NOOK in layout.ts.
    items += [
        ("pool_table", -2.85, -4.5, 0.0, 0.0, DIRECTOR),
        ("sofa", -2.85, -5.95, 0.0, 0.0, LOWER),
        ("coffee_table", -2.85, -4.75, 0.0, 0.0, LOWER),
        ("armchair", -3.4, -3.5, 0.0, PI, LOWER),
        ("armchair", -2.3, -3.5, 0.0, PI, LOWER),
        ("lounge_chair", -4.7, -5.5, 0.0, PI * 0.25, LOWER),
        ("plant_leafy", -5.0, -6.1, 0.0, 0.0, LOWER),
        ("plant_tall", -0.8, -6.0, 0.0, 0.0, LOWER),
    ]
    # Conference room
    items += [
        ("@conference_table", MEETING_TABLE[0], MEETING_TABLE[1], 0.0, 0.0),
        *[("office_chair", MEETING_TABLE[0] + dx, MEETING_TABLE[1] - CONFERENCE_CHAIR_Z, 0.0, 0.0)
          for dx in CONFERENCE_CHAIR_OFFSETS],
        *[("office_chair", MEETING_TABLE[0] + dx, MEETING_TABLE[1] + CONFERENCE_CHAIR_Z, 0.0, PI)
          for dx in CONFERENCE_CHAIR_OFFSETS],
        ("tv", 3.65, -6.42, 0.9, 0.0),
    ]
    # North-west corner sofa (its back along the west wall, the chaise along the north wall), the arcade facing
    # east beside it, and the kitchenette. Keep in sync with CORNER_SOFA / FURNITURE in layout.ts.
    items += [
        ("corner_sofa", -10.6, -5.11, 0.0, PI / 2),
        ("arcade", -11.05, -3.2, 0.0, PI / 2),
        ("kitchen_counter", -11.15, 0.0, 0.0, PI / 2),
        ("espresso", -11.1, -0.55, 0.92, PI / 2),
        ("trash_can", -11.1, 1.3, 0.0, PI / 2),
        ("plant_tall", -11.0, -1.9, 0.0, 0.0),
    ]
    # Lounge, foosball, beanbags
    items += [
        ("sofa", 0.0, 2.5, 0.0, 0.0),
        # Far enough from the sofa (front edge z = 2.95) for agents to step in and sit. Keep in sync with layout.ts.
        ("coffee_table", 0.0, 3.7, 0.0, 0.0),
        # Arc lamp: base behind the sofa (its base is 0.78 m north of its centre), the arc over the sofa and the
        # shade hanging above the coffee table. Keep in sync with FURNITURE.floorLamp in layout.ts.
        ("floor_lamp", -0.35, 1.75 + 0.78, 0.0, 0.0),
        ("lounge_chair", 1.9, 3.1, 0.0, -PI / 2),
        ("plant_leafy", 3.3, 2.6, 0.0, 0.0),
        # Where the reception desk used to be, in front of the ATLAS AI HQ sign.
        ("foosball", -7.8, -4.4, 0.0, 0.0),
        ("beanbag", 5.6, 3.4, 0.0, PI * 0.75),
        ("beanbag", 6.4, 2.6, 0.0, PI),
        ("beanbag", 7.2, 3.4, 0.0, -PI * 0.75),
        ("@side_table", 6.4, 3.35, 0.0, 0.0),
        ("plant_tall", -10.9, 5.9, 0.0, 0.0, LOWER),  # inside the executive office upstairs
        ("plant_tall", 10.9, 5.9, 0.0, 0.0),
    ]
    return items


# --- Helpers ---------------------------------------------------------------------------------------
def fresh_collection(name, hide=False):
    old = bpy.data.collections.get(name)
    if old:
        for obj in list(old.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.collections.remove(old)
    col = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(col)
    col.hide_render = hide
    return col


def import_asset(spec, col):
    before = set(bpy.data.objects)
    if "src" in spec:
        bpy.ops.import_scene.gltf(filepath=os.path.join(SRC, spec["src"]))
        objs = [o for o in bpy.data.objects if o not in before]
    else:
        folder = os.path.join(SRC, spec["blend"])
        blend = next(f for f in os.listdir(folder) if f.endswith(".blend"))
        with bpy.data.libraries.load(os.path.join(folder, blend), link=False) as (src, dst):
            dst.objects = list(src.objects)
        objs = [o for o in dst.objects if o is not None]
        for o in objs:
            bpy.context.scene.collection.objects.link(o)
        relink_images(objs, folder)
    for o in objs:
        for c in list(o.users_collection):
            c.objects.unlink(o)
        col.objects.link(o)
    return objs


def apply_modifiers(meshes):
    """Bakes modifiers into the mesh data, because joining keeps only the raw meshes: the pool table's legs are
    one leg plus Mirror modifiers, and lost three of them. Subdivision is switched off first (decimation would
    only take the extra faces back out)."""
    for o in meshes:
        if not o.modifiers:
            continue
        for mod in o.modifiers:
            if mod.type == "SUBSURF":
                mod.show_viewport = False
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for o in meshes:
        if not o.modifiers:
            continue
        baked = bpy.data.meshes.new_from_object(o.evaluated_get(depsgraph), preserve_all_data_layers=True,
                                                depsgraph=depsgraph)
        o.modifiers.clear()
        o.data = baked


def relink_images(objs, folder):
    """Appended .blend files can point their textures at the original author's disk (the pool table's do). Find
    each missing texture by file name under the asset's folder; unplug any still missing, because an image without
    data exports as a glTF texture with no source, which stops the whole GLB loading in the browser."""
    files = {}
    for root, _, names in os.walk(folder):
        for name in names:
            files.setdefault(name.lower(), os.path.join(root, name))
    for obj in objs:
        if obj.type != "MESH":
            continue
        for mat in obj.data.materials:
            if not mat or not mat.use_nodes:
                continue
            for node in mat.node_tree.nodes:
                img = getattr(node, "image", None)
                if node.bl_idname != "ShaderNodeTexImage" or img is None or img.packed_file or img.size[0] > 0:
                    continue
                found = files.get(os.path.basename(bpy.path.abspath(img.filepath)).lower())
                if found:
                    img.filepath = found
                    img.reload()
                if img.size[0] == 0:  # reading size loads the file
                    node.image = None
                    for link in list(node.outputs["Color"].links):
                        mat.node_tree.links.remove(link)


def world_bounds(objs):
    pts = [o.matrix_world @ Vector(c) for o in objs for c in o.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi


def node_images(tree, seen=None):
    """All images used by a node tree, including inside node groups."""
    seen = seen if seen is not None else set()
    for node in tree.nodes:
        img = getattr(node, "image", None)
        if img is not None:
            yield img
        group = getattr(node, "node_tree", None)
        if group is not None and group.name not in seen:
            seen.add(group.name)
            yield from node_images(group, seen)


def shrink_images(obj, size):
    for slot in obj.material_slots:
        mat = slot.material
        if not mat or not mat.use_nodes:
            continue
        for img in node_images(mat.node_tree):
            if img.get("atlas_size") == size or img.size[0] == 0:
                continue
            if max(img.size) > size:
                w, h = img.size
                k = size / max(w, h)
                img.scale(max(1, int(w * k)), max(1, int(h * k)))
            img.pack()
            img["atlas_size"] = size


def prepare(asset_id, spec, col):
    objs = import_asset(spec, col)
    meshes = [o for o in objs if o.type == "MESH"]
    # Drop helper meshes: named ground/shadow planes, scan debris, and zero-size animation leftovers.
    drop = set(spec.get("drop_names", []))
    drop_exact = set(spec.get("drop_exact", []))
    helpers = [o for o in objs if o.type != "MESH"]
    if spec.get("keep_parent"):
        # Files holding several pieces: keep the meshes under one parent empty.
        for o in [o for o in meshes if not (o.parent and o.parent.name.split(".")[0] == spec["keep_parent"])]:
            meshes.remove(o)
            bpy.data.objects.remove(o, do_unlink=True)
    if spec.get("keep_largest"):
        largest = max(meshes, key=lambda o: len(o.data.polygons))
        for o in [o for o in meshes if o is not largest]:
            meshes.remove(o)
            bpy.data.objects.remove(o, do_unlink=True)
    for o in list(meshes):
        lo, hi = world_bounds([o])
        if any(n in o.name for n in drop) or o.name.split(".")[0] in drop_exact or max(hi - lo) < 1e-4:
            meshes.remove(o)
            bpy.data.objects.remove(o, do_unlink=True)
    apply_modifiers(meshes)
    # Bake parent transforms into the meshes, then join into one object. World matrices are only
    # valid after a depsgraph update, and instanced meshes need their own data before applying.
    bpy.context.view_layer.update()
    for o in meshes:
        if o.data.users > 1:
            o.data = o.data.copy()
    with bpy.context.temp_override(active_object=meshes[0], selected_editable_objects=meshes, selected_objects=meshes):
        bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
    for o in helpers:
        bpy.data.objects.remove(o, do_unlink=True)
    bpy.context.view_layer.update()
    with bpy.context.temp_override(active_object=meshes[0], selected_editable_objects=meshes, selected_objects=meshes):
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        if len(meshes) > 1:
            bpy.ops.object.join()
    obj = meshes[0]
    # Remove loose vertices and edges (stray points can be metres away and break sizing).
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context="VERTS")
    bm.to_mesh(obj.data)
    bm.free()
    obj.name = f"proto_{asset_id}"
    obj.data.name = f"mesh_{asset_id}"
    # Face the front toward -Y. glTF imports use quaternion rotation, where rotation_euler is ignored.
    obj.rotation_mode = "XYZ"
    obj.rotation_euler = (0, 0, spec.get("turn", 0.0))
    with bpy.context.temp_override(active_object=obj, selected_editable_objects=[obj], selected_objects=[obj]):
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    # Scale to real-world size.
    lo, hi = world_bounds([obj])
    dims = hi - lo
    axis, metres = spec["size"]
    current = {"width": dims.x, "depth": dims.y, "height": dims.z}[axis]
    k = metres / current if current > 0 else 1.0
    obj.scale = (k, k, k)
    with bpy.context.temp_override(active_object=obj, selected_editable_objects=[obj], selected_objects=[obj]):
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    # Origin at the bottom centre.
    lo, hi = world_bounds([obj])
    offset = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
    obj.data.transform(__import__("mathutils").Matrix.Translation(-offset))
    obj.location = (0, 0, 0)
    # Decimate heavy meshes.
    tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    if spec.get("tris") and tris > spec["tris"]:
        mod = obj.modifiers.new("decimate", "DECIMATE")
        mod.ratio = spec["tris"] / tris
        mod.use_collapse_triangulate = True
        with bpy.context.temp_override(active_object=obj, object=obj):
            bpy.ops.object.modifier_apply(modifier=mod.name)
    legacy_to_principled(obj)
    shrink_images(obj, spec.get("tex", 1024))
    if spec.get("split_screen"):
        split_screen(obj)
    if spec.get("split_tv"):
        split_tv(obj)
    return obj


def legacy_to_principled(obj):
    """Old Cycles shaders (Diffuse, Anisotropic, Mix, Glass; e.g. the pool table's) do not export to glTF and
    come out plain white. Rebuild each such material as a Principled BSDF from its Diffuse colour or texture."""
    for slot in obj.material_slots:
        mat = slot.material
        if not mat or not mat.use_nodes:
            continue
        tree = mat.node_tree
        legacy = ("ShaderNodeBsdfDiffuse", "ShaderNodeBsdfGlass", "ShaderNodeBsdfAnisotropic", "ShaderNodeBsdfGlossy")
        # Leave modern materials alone, including unlit glTF ones (the snake plant), which have no Principled BSDF.
        if any(n.bl_idname == "ShaderNodeBsdfPrincipled" for n in tree.nodes) or not any(
            n.bl_idname in legacy for n in tree.nodes
        ):
            continue
        output = next((n for n in tree.nodes if n.bl_idname == "ShaderNodeOutputMaterial"), None)
        if output is None:
            continue
        diffuse = next((n for n in tree.nodes if n.bl_idname == "ShaderNodeBsdfDiffuse"), None)
        glass = next((n for n in tree.nodes if n.bl_idname == "ShaderNodeBsdfGlass"), None)
        glossy = any(n.bl_idname in ("ShaderNodeBsdfAnisotropic", "ShaderNodeBsdfGlossy") for n in tree.nodes)
        metal = any(word in mat.name.lower() for word in ("chrome", "steel", "alum"))
        bsdf = tree.nodes.new("ShaderNodeBsdfPrincipled")
        source = diffuse or glass
        color = source.inputs["Color"] if source else None
        if color is not None and color.is_linked:
            tree.links.new(color.links[0].from_socket, bsdf.inputs["Base Color"])
        elif metal:
            bsdf.inputs["Base Color"].default_value = (0.75, 0.75, 0.76, 1.0)
        elif color is not None:
            bsdf.inputs["Base Color"].default_value = color.default_value
        bsdf.inputs["Metallic"].default_value = 1.0 if metal else 0.0
        bsdf.inputs["Roughness"].default_value = 0.25 if (glossy or metal) else 0.85
        if glass:
            bsdf.inputs["Alpha"].default_value = 0.25
            bsdf.inputs["Roughness"].default_value = 0.05
        tree.links.new(bsdf.outputs["BSDF"], output.inputs["Surface"])


def split_screen(obj):
    """Gives the monitor's front-facing panel its own "ATLAS_Screen" material so the app can light it per desk."""
    screen = bpy.data.materials.get("ATLAS_Screen") or bpy.data.materials.new("ATLAS_Screen")
    screen.use_nodes = True
    bsdf = screen.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (0.01, 0.012, 0.015, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.15
    bsdf.inputs["Emission Color"].default_value = (0.0, 0.0, 0.0, 1.0)
    obj.data.materials.append(screen)
    index = len(obj.data.materials) - 1
    lo, hi = world_bounds([obj])
    height = hi.z - lo.z
    count = 0
    for poly in obj.data.polygons:
        c = poly.center
        # Front faces point toward -Y; the panel sits above the stand and inside the bezel.
        if poly.normal.y < -0.55 and c.z > lo.z + height * 0.36 and abs(c.x) < (hi.x - lo.x) * 0.47:
            poly.material_index = index
            count += 1
    obj["atlas_screen_faces"] = count
    screen_uvs(obj, index)


def screen_uvs(obj, material_index):
    """Maps the screen faces flat onto the whole 0-1 UV square (u across, v up), so the app can draw a picture
    (a terminal, the meeting board) straight onto the screen. Front faces look toward -Y."""
    mesh = obj.data
    uv = mesh.uv_layers.active or mesh.uv_layers.new(name="UVMap")
    polys = [p for p in mesh.polygons if p.material_index == material_index]
    xs = [mesh.vertices[v].co.x for p in polys for v in p.vertices]
    zs = [mesh.vertices[v].co.z for p in polys for v in p.vertices]
    x0, x1, z0, z1 = min(xs), max(xs), min(zs), max(zs)
    for p in polys:
        for loop_index in p.loop_indices:
            co = mesh.vertices[mesh.loops[loop_index].vertex_index].co
            uv.data[loop_index].uv = ((co.x - x0) / (x1 - x0), (co.z - z0) / (z1 - z0))


def split_tv(obj):
    """Gives the conference TV's front panel its own "ATLAS_TVScreen" material (inside a 4 cm bezel)."""
    screen = bpy.data.materials.get("ATLAS_TVScreen") or bpy.data.materials.new("ATLAS_TVScreen")
    screen.use_nodes = True
    bsdf = screen.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (0.01, 0.012, 0.015, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.15
    obj.data.materials.append(screen)
    index = len(obj.data.materials) - 1
    lo, hi = world_bounds([obj])
    count = 0
    for poly in obj.data.polygons:
        c = poly.center
        if poly.normal.y < -0.9 and lo.x + 0.04 < c.x < hi.x - 0.04 and lo.z + 0.04 < c.z < hi.z - 0.04:
            poly.material_index = index
            count += 1
    obj["atlas_screen_faces"] = count
    screen_uvs(obj, index)


def simple_material(name, color, roughness=0.5, metallic=0.0):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    return mat


def procedural_desk(col, name, width, depth):
    """Modern workstation: oak top on a black steel frame with a modesty panel."""
    oak = simple_material("ATLAS_DeskOak", (0.42, 0.25, 0.13), 0.45)
    steel = simple_material("ATLAS_DeskSteel", (0.02, 0.022, 0.025), 0.35, 0.8)
    mesh = bpy.data.meshes.new(f"mesh_{name}")
    bm = bmesh.new()
    parts = [
        ((0, 0, DESK_TOP_Y - 0.02), (width, depth, 0.04), 0),
        ((-width / 2 + 0.04, 0, (DESK_TOP_Y - 0.04) / 2), (0.05, depth - 0.08, DESK_TOP_Y - 0.04), 1),
        ((width / 2 - 0.04, 0, (DESK_TOP_Y - 0.04) / 2), (0.05, depth - 0.08, DESK_TOP_Y - 0.04), 1),
        ((0, depth / 2 - 0.06, 0.45), (width - 0.1, 0.02, 0.45), 1),
    ]
    for (cx, cy, cz), (sx, sy, sz), mat_index in parts:
        geom = bmesh.ops.create_cube(bm, size=1.0)
        for v in geom["verts"]:
            v.co.x = cx + v.co.x * sx
            v.co.y = cy + v.co.y * sy
            v.co.z = cz + v.co.z * sz
        for f in {f for v in geom["verts"] for f in v.link_faces}:
            f.material_index = mat_index
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(oak)
    mesh.materials.append(steel)
    obj = bpy.data.objects.new(f"proto_{name}", mesh)
    col.objects.link(obj)
    return obj


def conference_table(col, width=4.6, depth=1.15):
    """Long oak meeting table on two black steel panel legs."""
    oak = simple_material("ATLAS_DeskOak", (0.42, 0.25, 0.13), 0.45)
    steel = simple_material("ATLAS_DeskSteel", (0.02, 0.022, 0.025), 0.35, 0.8)
    mesh = bpy.data.meshes.new("mesh_conference_table")
    bm = bmesh.new()
    leg_h = DESK_TOP_Y - 0.05
    parts = [((0, 0, DESK_TOP_Y - 0.025), (width, depth, 0.05), 0)]
    for side in (-1, 1):
        parts.append(((side * (width / 2 - 0.45), 0, leg_h / 2), (0.08, depth - 0.3, leg_h), 1))
        parts.append(((side * (width / 2 - 0.45), 0, 0.015), (0.3, depth - 0.2, 0.03), 1))
    parts.append(((0, 0, leg_h - 0.04), (width - 0.9, 0.08, 0.06), 1))  # stretcher under the top
    for (cx, cy, cz), (sx, sy, sz), mat_index in parts:
        geom = bmesh.ops.create_cube(bm, size=1.0)
        for v in geom["verts"]:
            v.co.x = cx + v.co.x * sx
            v.co.y = cy + v.co.y * sy
            v.co.z = cz + v.co.z * sz
        for f in {f for v in geom["verts"] for f in v.link_faces}:
            f.material_index = mat_index
    # Soften the top's edges a little so it catches highlights.
    top_edges = [e for e in bm.edges if all(abs(v.co.z - DESK_TOP_Y) < 1e-4 for v in e.verts)]
    bmesh.ops.bevel(bm, geom=top_edges, offset=0.012, segments=2, affect="EDGES")
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(oak)
    mesh.materials.append(steel)
    obj = bpy.data.objects.new("proto_conference_table", mesh)
    col.objects.link(obj)
    return obj


def side_table(col):
    wood = simple_material("ATLAS_SideTable", (0.36, 0.22, 0.12), 0.5)
    bpy.ops.mesh.primitive_cylinder_add(radius=0.25, depth=0.44, location=(0, 0, 0.22))
    obj = bpy.context.active_object
    obj.name = "proto_side_table"
    obj.data.materials.append(wood)
    for c in list(obj.users_collection):
        c.objects.unlink(obj)
    col.objects.link(obj)
    return obj


def conference_chair_spots(proto):
    """Finds chair positions in the conference set: clusters of geometry near the floor beside the table."""
    me = proto.data
    pts = [v.co for v in me.vertices if v.co.z < 0.12]
    cells = {}
    for p in pts:
        key = (round(p.x / 0.3), round(p.y / 0.3))
        cells.setdefault(key, []).append(p)
    # Merge neighbouring cells into clusters.
    seen, clusters = set(), []
    for key in cells:
        if key in seen:
            continue
        stack, members = [key], []
        seen.add(key)
        while stack:
            k = stack.pop()
            members += cells[k]
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    n = (k[0] + dx, k[1] + dy)
                    if n in cells and n not in seen:
                        seen.add(n)
                        stack.append(n)
        cx = sum(p.x for p in members) / len(members)
        cy = sum(p.y for p in members) / len(members)
        clusters.append((round(cx, 3), round(cy, 3), len(members)))
    return sorted(clusters, key=lambda c: (c[1], c[0]))


def build():
    # Build next to the shell in the main scene, not in the inventory staging scene.
    bpy.context.window.scene = bpy.data.scenes.get("Scene") or bpy.data.scenes[0]
    keep = {c.name for c in bpy.data.collections if c.name.startswith("ATLAS_Shell")}
    for obj in list(bpy.context.scene.collection.objects):
        bpy.data.objects.remove(obj, do_unlink=True)  # loose imports left at the scene root
    staging = bpy.data.scenes.get("ATLAS_Staging")
    if staging:
        bpy.data.scenes.remove(staging)
    protos_col = fresh_collection(PROTOS, hide=True)
    placed_col = fresh_collection(PLACED)
    protos = {asset_id: prepare(asset_id, spec, protos_col) for asset_id, spec in ASSETS.items()}
    protos["@desk"] = procedural_desk(protos_col, "desk", 1.7, 0.8)
    protos["@side_table"] = side_table(protos_col)
    protos["@conference_table"] = conference_table(protos_col)
    counts = {}
    for asset, x, z, y, rot, *tag in placements():
        proto = protos[asset]
        n = counts.get(asset, 0)
        counts[asset] = n + 1
        prefix = f"{tag[0]}__" if tag else ""
        inst = bpy.data.objects.new(f"{prefix}{asset.strip('@')}_{n}", proto.data)  # linked duplicate: shared mesh
        inst.location = (x, -z, y)
        inst.rotation_euler = (0, 0, rot)
        placed_col.objects.link(inst)
    return placed_col, counts


def byte_images(col):
    """WebP export fails (leaving textures without a source, which breaks loading) for grayscale, 16-bit and
    float images. Swap those for 8-bit RGBA copies first."""
    swapped = {}

    def trees(tree):
        yield tree
        for node in tree.nodes:
            if node.type == "GROUP" and node.node_tree:
                yield from trees(node.node_tree)

    for obj in col.all_objects:
        if obj.type != "MESH":
            continue
        for mat in obj.data.materials:
            if not mat or not mat.use_nodes:
                continue
            for tree in trees(mat.node_tree):
                for node in tree.nodes:
                    img = node.image if node.type == "TEX_IMAGE" else None
                    if img is None or img.size[0] == 0 or (img.depth in (24, 32) and not img.is_float):
                        continue
                    if img.name not in swapped:
                        w, h = img.size
                        copy = bpy.data.images.new(img.name + "_8bit", w, h, alpha=True, float_buffer=False)
                        copy.colorspace_settings.name = img.colorspace_settings.name
                        px = np.empty(w * h * 4, dtype=np.float32)
                        img.pixels.foreach_get(px)
                        copy.pixels.foreach_set(np.clip(px, 0, 1))
                        copy.pack()
                        swapped[img.name] = copy
                    node.image = swapped[img.name]
    return len(swapped)


def export(col):
    byte_images(col)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    layer = bpy.context.view_layer
    for obj in layer.objects:
        obj.select_set(False)
    for obj in col.objects:
        obj.select_set(True)
    layer.objects.active = col.objects[0]
    layer.active_layer_collection = layer.layer_collection.children[col.name]
    bpy.ops.export_scene.gltf(
        filepath=OUT,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_image_format="WEBP",
        export_image_quality=80,
        export_materials="EXPORT",
        export_lights=False,
        use_active_collection=True,
        use_active_scene=True,
        export_meshopt_compression_enable=True,
    )
    return os.path.getsize(OUT)


placed, counts = build()
size = export(placed)
result = {"placed": len(placed.objects), "assets": counts, "glb_bytes": size}
